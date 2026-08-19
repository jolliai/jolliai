# Transcript UUID Identity (v5 Schema) and One-Shot Migration

## Topic Statement

The v5 transcript identity scheme assigns opaque random UUIDs to newly captured transcripts (decoupling transcript storage keys from commit hashes), preserves legacy commit-hash filenames verbatim as opaque IDs during a one-shot normalization pass that upgrades every stored summary to the v5 shape, and stamps the migration as completed only after both the primary and shadow storage backends accept the write.

## Scope

**In scope:**

- The format and generation rule for a fresh transcript identifier under v5, and the set of writers that allocate one — including the one non-pipeline allocator.
- The way legacy (pre-v5) commit-hash transcript filenames become v5 IDs without any rename.
- The opaque-ID contract that downstream readers, write paths, and display surfaces uphold.
- Persisting an explicit "transcripts referenced by this summary" array on every v5 summary root, plus the optional repair stamp a v5 root may carry beside it and what the migration does with it.
- The per-node shape the migration leaves behind — everything on the root, nothing on the descendants — and the fact that this shape is now load-bearing input to the per-node usage attribution other topics resolve over it.
- The tree-wide removal of a set of identifiers from an already-stored summary: which nodes it rewrites, which marker it does and does not stamp, and how the caller learns whether a write is owed at all.
- The on-startup, one-shot, idempotent migration that normalizes legacy summaries to v5 (including the v3 → v4 → v5 collapse).
- The two-step write ordering (content first, completion marker second) and the gate on the completion marker.
- The recovery path when a prior attempt left the primary storage at v5 but the shadow storage stale.
- Resumption semantics after crashes, lock contention, concurrent migration attempts, and shadow-write failures.
- Reporting telemetry returned to callers and surfaced in the "status" / "migrate" command outputs.

**Out of scope:**

- The legacy "flat records" → "unified hoist tree" payload reshape and the legacy index version flip (covered by spec 06 — schema migration through prior versions; the present spec is the next migration in the same chain and supersedes 06's scope for the v5 step).
- The orphan-branch storage primitives that read and write summaries (covered by spec 01).
- The folder-based shadow storage primitives (covered by spec 02).
- The dual-write fan-out semantics that wrap both primary and shadow (covered by spec 03).
- The unified-hoist tree shape itself, hoist invariants, and topic/recap propagation (covered by spec 04).
- The index format and per-node entries (covered by spec 05).
- The write-time path used by the live commit/amend/squash pipeline to allocate fresh IDs in normal operation (covered by the queue worker and pipeline specs).
- The display surfaces that resolve transcript IDs to rendered conversations.
- The attribution rule itself — how a single owning node is chosen for an identifier, and what happens when none can be — which reads the shape described here but is defined in [333 — Conversation Usage Recomputation from Transcripts] and restated in [306 — Conversation Detach Usage Correction].
- What causes an identifier to go stale in the first place, and the outcome reporting around the removal (see [306] and [333]).

## Data Contracts

### Transcript identifier

A non-empty opaque string. Two formats coexist in the same namespace; readers and storage code treat both identically:

- **Fresh-v5 form**: a 36-character RFC 4122 version-4 UUID containing four hyphens. Lowercase hex digits.
- **Legacy form**: the original commit-hash text that was the transcript file's filename before migration. Lowercase hex, hyphen-free, length-agnostic at the parsing layer (in practice 40 characters in production).

No code path may parse a transcript ID for semantics — there is no encoded structure beyond "string." A reader that constrains the format to one of these two shapes (for example by requiring all-hex characters) drops the other shape silently; the contract requires accepting any non-empty string before the file extension.

### Transcript file path

Every transcript is stored at a path of the shape `<transcripts-prefix>/<id>.<json-extension>`, where `<id>` is the opaque transcript ID. The prefix and extension are fixed values shared with the rest of the storage layout. The parser that extracts an ID from a path captures everything between the prefix and the extension verbatim, regardless of internal characters (hyphens are not separators).

### Summary record (v5 root)

A v5 summary root carries every field of the v4 root plus an additional **transcripts** field whose value is a list of opaque transcript IDs. The list:

- Is always present on a v5 root, including when empty.
- Contains only IDs whose backing transcript file exists at the time the list was constructed (the write-time filter rule; see "Behavior").
- Is the authoritative reference for "which conversations belong to this commit's summary"; consumers do not re-derive it by walking the tree.

A v5 record stamped with the version marker but missing the transcripts field is treated as anomalous (a hand-edit or bug) and is repaired by the migration on its next pass.

A v5 root may additionally carry a **transcriptsRepairedAt** stamp: an ISO timestamp recording that this summary's empty transcripts list was refilled after the fact from local transcript history rather than captured live. It is purely additive — no schema bump, no change to any of the rules above — and it does two jobs. It is the repair's **idempotency key**: a summary carrying it is never a repair candidate again, so a repeated run cannot mint a second transcript artifact for the same evidence window. And it is the signal three display surfaces read to say the conversation was recovered from local history instead of implying it was captured while the work happened. The migration's v5 fast path leaves a record carrying it untouched. The repair that writes it is owned by a neighbouring topic.

### Migration state record

A small structured value persisted under a fixed name in the active storage backend. Fields:

- **schema version of the state record itself** (a constant integer).
- **status**: one of "in-progress," "completed," or "failed." Only "completed" is ever written by the current code path; absence of the record is the implicit "pending" state. The "in-progress" and "failed" values are reserved by the schema but never written.
- **startedAt** (ISO timestamp): when the current attempt began.
- **completedAt** (ISO timestamp, optional): set on successful completion.
- **migratedCount** (integer): summaries the attempt upgraded to v5 (excluding already-v5 records).
- **skippedCount** (integer): summaries the attempt left unchanged (already v5, unparseable, or read-missing).
- **fresh** (boolean): true when no v3/v4 data existed at migration time.
- **errorMessage** (string, optional): reserved by the schema; not populated by the current code path.

Absence of the record is interpreted as "needs to run on next startup." Presence with status "completed" is interpreted as "skip; idempotent fast-path."

### Migration result returned to callers

A four-field record reported back to the call site (not persisted):

- **migrated**: count of summaries upgraded this run.
- **skipped**: count of summaries left unchanged this run.
- **fresh**: true when no pre-v5 data existed.
- **alreadyDone**: true when the state record already showed completion.

### Lock identifier

The migration shares the same coarse-grained "orphan write" lock used by the live commit pipeline. The lock has a fixed timeout (about thirty seconds) above which the migration declines to start.

## Behavior

### Generating a fresh transcript identifier

When any live write path creates a new transcript, it requests a fresh identifier from a single shared helper. The helper returns an RFC 4122 v4 UUID generated by the platform's cryptographic random source. Each call produces a distinct value; no caching, no derivation from content, no derivation from commit metadata. The caller writes the transcript file at `<transcripts-prefix>/<uuid>.<json-extension>` and stamps the same UUID into the owning summary's transcripts list.

**Not every allocator is a live pipeline write path.** One **non-pipeline** writer allocates fresh identifiers too: the diagnostic command's transcript-repair form, when run with its apply flag. It mints one fresh identifier per repaired summary and creates that identifier's transcript artifact in the **same store call** that writes the summary — so the file-existence invariant the transcripts list is under holds by construction rather than by a filter, and the identifier is a fresh UUID for the same reason every pipeline-allocated one is (it names a conversation slice, not a commit). The repair's own decision rules are owned by a neighbouring topic; what belongs here is that a v5 identifier can now originate outside the commit pipeline.

Live write paths never reuse a commit hash as the transcript ID. Reuse of commit-hash text as an ID is reserved for the migration's "legacy preservation" mode, where existing files keep their names and the existing name becomes the v5 ID.

### Parsing a transcript identifier from a path

The shared parser matches a path against the fixed `<prefix>/<id>.<ext>` template. The id segment is captured verbatim — accepting hyphens, mixed case, any length, any non-extension character. Paths that don't match the template (wrong prefix, no extension, empty id between prefix and extension) yield no result and are ignored by every caller that scans the transcripts directory.

This format-agnostic capture is required for correctness: a stricter pattern silently drops UUID-form IDs (the version-4 UUID's mandatory hyphens fail a hex-only filter), hiding all freshly-written v5 transcripts from any consumer that intersects file listings with a summary's referenced IDs.

### When the migration runs

Two callers invoke the one-shot migration during normal operation, plus one explicit operator invocation:

1. The installer (which sets up hooks the first time, and re-checks on subsequent runs) calls the migration unless the install was initiated by the editor extension.
2. The editor extension calls the migration during activation, gated on a "needs work" check that first reads the persisted state. When work is pending the extension toggles a "migrating" affordance across its sidebar panels for the duration of the call. The installer call site is suppressed when invoked from the extension to avoid both call sites racing for the lock.
3. The operator-issued migrate command unconditionally calls the migration as its final step (after the legacy v1 → v3 payload reshape and the legacy index-version flip from spec 06).

Every caller wraps the call in a try/catch and logs warnings only — failure is non-fatal. The next process startup retries.

### Migration top-level flow

The migration entry point performs these steps in order:

1. **Resolve the storage backend** before acquiring any lock. Locating the backend requires reading the machine-global config file; doing that disk I/O inside the lock would prolong the window during which concurrent live writers wait. The backend resolution is stateless until the first write, so it is safe to do up front.
2. **Read the persisted state record through the resolved backend.** If the record shows "completed," return immediately with the persisted counts and `alreadyDone=true`. The fast-path does not enumerate any summaries.
3. **Probe whether the backend is initialized.** "Initialized" means the orphan branch exists (for primary-backed modes) or the shadow folder exists (for shadow-only mode). When uninitialized, return `migrated=0, skipped=0, fresh=true, alreadyDone=false` without writing a state record. The migration must not create the backend as a side effect of running on a fresh project; the first real write creates it, and the next startup picks the migration up.
4. **Acquire the shared write lock** with a fixed timeout. If acquisition fails, throw — the caller is required to log and defer to the next startup.
5. **Recheck the state record under the lock.** Two processes can pass the outside-the-lock check and queue on the lock; without this recheck the second would rescan every (now-v5) summary, write a misleading "migrated=0" state, and overwrite the fresh "completed" record. When the recheck shows "completed," return that result and release the lock.
6. **Capture the pre-migration head identifier** of the primary backend. This is best-effort (a failure here is swallowed and logged); the captured value is written only to the debug log as a manual-recovery anchor for support staff. Users never see it.
7. **Enumerate every summary path** via the storage layer's directory listing primitive.
8. **Enumerate every transcript path**, parse each into its opaque ID, and collect the IDs into a set. Paths that don't match the transcript template are silently ignored. Fresh installs return an empty set without erroring.
9. **Batch-read every summary's content** via the storage layer's batch-read primitive when available, falling back to a per-path read loop when the active backend doesn't expose a batch primitive. The result is a map keyed by path; a present-but-null entry means "the read reported the file missing at read time" (a legitimate race against concurrent deletion), while a missing entry would be a protocol contract violation.
10. **Upgrade each summary** following the per-record rules below.
11. **Decide what to write** following the recovery branch below.
12. **Write the content** as one atomic batch when there is any content to write.
13. **Probe whether the shadow flagged itself dirty** during the content write.
14. **Stamp the completion marker** as a separate atomic write, only when the shadow is clean.
15. **Release the lock** (always, including on failure, via the wrapper's cleanup path).

### Per-record upgrade rules

For each summary that was read successfully (skipping any whose batched read returned the null-missing sentinel and any whose JSON failed to parse — both increment skipped and continue):

1. **v5 fast-path**: if the record's version field is already at v5 *and* the transcripts field is present, return the input reference unchanged. The record is excluded from the write batch and counted as skipped.
2. **v5-missing-transcripts repair**: if the record's version is v5 but the transcripts field is undefined (a hand-edit or bug), fall through into the recompute branch below. Do not treat it as already-migrated — left alone, the read path would force a v3/v4 children-walk fallback on it forever.
3. **Lossless v3 → v4 collapse**: run the shared "normalize to v4" helper over the input. This preserves topics, recap, plans, notes, external references, e2e test scenarios, doc fields, orphaned-doc IDs, and converts the legacy "stats" field to "diffStats" while computing the aggregate diff stats for amend containers (delta plus children). For records already at v4 this is a near-identity pass.
4. **v5-aware-writer pass-through**: if the resulting v4 record carries an authoritative transcripts list (because a v5-aware live writer stamped it before the migration ever ran), preserve that list verbatim and only bump the version marker to v5. Do not recompute the list from the children tree — recomputation would replace the authoritative UUID list with commit-hash children, and the file-existence filter (see next step) would typically drop them all, yielding a misleading empty list.
5. **Recompute the transcripts list**: collect every commit hash reachable in the (already-v4) tree via the children walk. Intersect that list with the set of IDs whose transcript file actually exists on disk (built in step 8 of the top-level flow). The resulting filtered list is the v5 transcripts array. An empty array is the correct outcome when no commit in the tree has a captured AI session — distinct from "undefined," which would force the read path back through the legacy fallback.

The output record is the v4 collapse output with the version marker set to v5 and the transcripts field set as above. The legacy "stats" field, if it survived the v3 → v4 collapse, is dropped — a v5 record carrying both "stats" and "diffStats" would be the anti-pattern that prevents removing the read-time stats → diffStats fallback later.

### Legacy filename preservation

The transcripts directory itself is never rewritten by the migration. Files that already live at `<prefix>/<commitHash>.<ext>` keep that name. Their hex commit-hash string becomes the v5 ID for those records.

This is deliberate: physically renaming hundreds or thousands of transcript files plus updating every referencing summary in lockstep would compound the migration's failure modes. Keeping the names and treating the existing strings as opaque IDs is a no-rename, in-place upgrade that costs only a per-summary content rewrite.

Mixing UUID-form and commit-hash-form IDs in the same array (and in the same on-disk directory) is fully supported by the contract. Both forms route through the same parser, the same storage primitives, and the same display code.

### The shape the upgrade leaves behind, and why it is now an input rather than just an output

The recompute branch collects every commit hash reachable through the children tree and writes the filtered result onto the **root**. The descendants themselves are not touched at all: no identifier array is added to them, and their version markers are left at whatever they were written under. So a migrated consolidated memory has every identifier in one place, at the top, and nothing anywhere below it.

That was chosen for blast radius — one rewrite per summary rather than a coordinated rewrite of a whole tree — but it has become load-bearing for a second reason. Any caller that corrects a memory's per-node figures must decide which **single** node's figures cover a given identifier, and on this shape the root is the sole node listing identifiers whose figures actually sit on a child. The only remaining evidence that points back at the right child is that the identifier **is** that child's commit hash — which is true precisely because the migration reuses the legacy filename verbatim instead of renaming it. Had the files been renamed to fresh opaque identifiers, every memory this migration produced would be permanently unattributable per node.

Two shapes therefore behave differently under that rule, and both are normal:

- **Pre-upgrade**: no node carries an identifier array at all, so the commit-hash correspondence is the *only* evidence available.
- **Post-upgrade**: the root carries all of them, so the correspondence is what moves attribution back down into the subtree the root claimed on behalf of.

A memory written natively at v5 by the live pipeline is the third shape, and the one this concern does not apply to: its identifiers are opaque values with no correspondence to any commit hash, and the nodes that list them are the nodes whose figures cover them.

### Removing identifiers from a stored summary

A caller that needs a set of identifiers gone from an already-stored summary (a conversation archive that was emptied, or a reference left dangling by a lost write) hands the summary and the set to one removal routine. It rewrites **every node**, not only the root:

- **The root's list** is filtered. On a record that already carries one, that is a plain filter. On a **pre-upgrade** record — which has no list — the effective list is instead taken from the caller's *file-backed* set: the tree's identifiers already intersected with the archive files that exist. That mirrors the migration's own file-existence filter exactly, so the removal cannot bake a dangling identifier into a list that is supposed to be authoritative and file-backed.
- **Every descendant's own list** is filtered too. This is not defensive breadth: the shape the routine is called on is precisely the one where the root's list is short or empty while a child still lists the identifier, so filtering the root alone would report success, leave the dead identifier on disk, and — because the figures beside it were corrected in the same write — make every later attempt conclude that everything already matches while the stale reference survives indefinitely.
- **A descendant carrying no list is left untouched**, not given an empty one. The field's absence is what marks a node as pre-upgrade-nested, and manufacturing an empty array would erase that distinction.
- **A descendant's version marker is deliberately not stamped.** The migration never stamps descendants, so a child's marker records the schema it was written under and nothing routes a read off it; bumping it here would claim a migration that did not happen.
- **The root's version marker and identifier field are always stamped** on any write this routine performs. That is the lazy upgrade: a pre-upgrade record that reaches this path is written back as a full post-upgrade record rather than as a hybrid carrying an identifier list under an older marker, which a version-routing reader would misclassify.

The routine answers with the **same summary reference** when nothing needed changing, and callers use that identity — not the size of the set they asked to remove — to decide whether a write actually happened. There is one asymmetry inside that rule: a **pre-upgrade** record with a non-empty file-backed set counts as changed even when the filter removed nothing, because writing it *is* the upgrade. A pre-upgrade record whose file-backed set is empty has neither a list to upgrade nor anything to remove, and is returned unchanged.

### Decision: normal write versus recovery re-push

After per-record upgrade, two summary tallies exist:

- **migrated**: count of records the upgrade actually changed (a write is enqueued for each).
- **skipped**: count of records the upgrade left unchanged (no write enqueued).
- **fresh**: true when the summaries list was empty (no records of any kind).

The "recovery re-push" branch fires when reaching the locked migration body finds `migrated=0` and `skipped>0` (some records existed and all were already v5). The interpretation: a prior attempt upgraded the primary backend to v5 but did not finish cleanly — the classic cause is a dual-write run where the shadow write failed and was swallowed-and-flagged-dirty, leaving primary correct but shadow stranded at v4. The naive "skip unchanged → write nothing" path would never give the shadow a chance to catch up, and once the completion marker landed it would lock out any retry forever.

The recovery branch instead enqueues a write for *every* summary's current (already-v5) serialized content, so the dual-write fan-out re-attempts the shadow with the up-to-date payload. This costs a redundant primary rewrite on the rare recovery path; the common first-migration path enqueues only changed records.

The decision rule:

- If `migrated == 0 && skipped > 0`: enqueue writes for **every** summary, with a commit message indicating recovery.
- Otherwise (the normal case including fresh installs): enqueue writes only for **changed** summaries.

In the fresh-install case (`migrated == 0 && skipped == 0`), the content list is empty; only the completion marker is written.

### Two-step write ordering

The migration performs at most two atomic batch writes per run, in order:

1. **Content write**: every summary file from the content decision above, as one atomic batch with a human-readable commit message ("Schema v5 migration: N upgraded, M skipped" / "Schema v5 migration: re-pushing K v5 summaries to heal storage shadow" / "Schema v5 migration: no pre-v5 data found"). When the content list is empty this write is skipped.
2. **Completion marker write**: the persisted state record alone, as a separate atomic batch with the same commit message.

The two writes are intentionally separate. Bundling them would mean the marker lands the instant the primary succeeds, even if the shadow silently failed — a misleading "completed" gate that would permanently strand the shadow at the old schema.

### Completion marker gate

Between the two writes, the migration queries the active storage backend for a "shadow dirty" signal. The backend exposes this as an optional probe; backends without a swallowing shadow (primary-only and shadow-only modes) either omit the probe or return false. The dual-write backend returns true when any shadow write in the current session was caught-and-swallowed.

When the probe returns true: the migration logs a warning ("storage shadow write failed — leaving state PENDING; next startup will retry and re-push") and returns `migrated, skipped, fresh, alreadyDone=false` *without* writing the completion marker. The state record remains absent, so the next startup re-enters the migration; that retry finds primary already-v5 (`migrated=0, skipped>0`), takes the recovery branch, and re-pushes every summary to give the shadow another chance.

When the probe returns false (or is absent): the completion marker is written with status "completed," current timestamp as `completedAt`, and the migrated/skipped counts. The migration returns success.

### Concurrency

The shared write lock serializes the migration against every other writer on the same backend, including live commit-pipeline writes and other migration attempts. A migration that holds the lock for tens of seconds can starve concurrent commit-pipeline writers; those writers wait up to the same fixed lock timeout (about thirty seconds) and then drop their work according to their own fire-and-forget semantics (covered by the queue worker spec). This is a documented trade-off: a single long migration is rare and the alternative — finer-grained locking — risks partial state.

When two callers (for example the editor extension during activation and an operator-issued migrate command) both race for the lock, the second one's in-lock recheck finds the completed marker the first one wrote and returns the fast-path result without rescanning.

### Failure handling

Any storage primitive that throws (list, batch read, write, lock-release path) propagates as a thrown exception from the migration call. The lock is always released via the wrapper's cleanup path. The completion marker is *not* written on a throw, so the next startup re-enters the migration and sees "pending."

Specific narrower failures within the upgrade loop:

- **Unparseable JSON** for a summary increments skipped, logs a warning, and continues.
- **Null content** for a summary (the batched read reported the file missing) increments skipped and continues silently.
- **Missing map entry** for a summary (the batched read omitted a requested path entirely) throws — this is a protocol violation by the storage layer, not a benign race, and silent recovery would mask future regressions.
- **Pre-migration head identifier capture** failure is swallowed and logged at info level; the recovery anchor is best-effort and the migration proceeds.

### Reporting

The migration returns its result to callers, who decide how to surface it:

- The installer logs a single info line with all four result fields.
- The editor extension logs the same line during activation and clears its sidebar "migrating" affordance once the call returns (success or failure).
- The operator-issued migrate command prints one of three messages depending on the result: "Already migrated" when `alreadyDone`, "No orphan branch yet — migration will run automatically after the first commit" when `fresh && !alreadyDone`, or "Migrated: N summaries upgraded to v5" plus an optional "Skipped: M summaries (already v5 or unparseable)" line otherwise.

The state-inspection helper (used by the "status" command and the editor's status panel) reads the persisted state through the same backend resolution and treats absence as "not migrated." It tolerates unparseable state by treating it as absent.

### Read-side compatibility during the rollout window

Readers that need "which transcripts does this summary reference" funnel through a single compatibility helper:

- If the summary's transcripts field is present (the v5 fast path, including post-migration data and pre-migration v5-aware writes), return it verbatim.
- Otherwise (legacy v3/v4 data on a project where the migration has not yet run), walk the children tree, treat each commit hash as an opaque transcript ID, and return the collected list.

This is the dual-shape contract that lets a project read its own data correctly before and after the one-shot migration runs. The migration's job is to flip every record to the fast path; the helper exists for the rollout window. A future release where every project has migrated removes the fallback branch and reduces the helper to a direct field read.

### What is and isn't rewritten

The migration rewrites only the summary files under the summaries prefix and the completion marker file. Specifically out of scope per the migration's contract:

- **Transcript files are not renamed.** Their legacy commit-hash filenames become the legacy v5 IDs.
- **The index file is not rewritten.** The upgrade is in-place (same commit hashes, same tree shape, same source-tree references), so existing index entries already point at the right summaries. Leaving the index untouched keeps the migration's blast radius small.
- **Plans, notes, catalog, and other non-summary state are not touched.**

## State Transitions

The migration moves the persisted state record through these phases:

- **Absent (implicit pending)**: the default and the post-failure state. On startup, the migration runs.
- **Completed**: written exactly once after both writes (content + marker) succeed with the shadow clean. On subsequent startups, the fast-path returns without scanning.

The schema reserves two additional values ("in-progress" and "failed") that the current code never writes. A future version may use them; current readers tolerate them by treating anything other than "completed" as "pending."

Per-record transitions during a run: each input summary ends up in one of {already-v5-pass-through, upgraded-and-written, repaired-and-written (v5-missing-transcripts), recovery-re-pushed (already-v5 but re-written), unparseable-skipped, null-missing-skipped}.

System-level transitions across startups:

- **First startup with pre-v5 data, dual-write healthy**: content + marker written, state goes Absent → Completed in one run.
- **First startup with pre-v5 data, shadow write fails**: content written to primary only, shadow flagged dirty, marker withheld, state remains Absent. Next startup: enters recovery branch.
- **Recovery startup (primary already v5, shadow lagging)**: re-pushes every summary, marker written if shadow now clean, state goes Absent → Completed.
- **Fresh install (no backend yet)**: returns without touching anything, state remains Absent. The first real commit creates the backend; the next startup runs the normal flow.

## Notable Behavior

### Mixed-form IDs are permanent, not transitional

The v5 contract does not require a future renaming pass to homogenize legacy commit-hash IDs into UUID form. Both forms are opaque strings forever. New transcripts get UUIDs because the live write path needs an identifier decoupled from any commit hash (rebases, amends, and squashes rewrite history without rewriting transcripts), but the legacy IDs that survived the migration stay as commit-hash text indefinitely. There is no "phase 2" rename.

### The completion marker is never written eagerly

Even when a record is stamped as "in-progress," the current code never writes that value. The state file is either absent or "completed." Crashes between the content write and the marker write leave the state absent, which the next startup correctly interprets as pending. The schema preserves the "in-progress"/"failed" values to give a future version room to surface partial progress without breaking the file format.

### The shadow-dirty gate is the central correctness property

Without the gate, the marker would land on the primary's successful write alone, locking out future retries while the shadow remains at v4. The product would show "migration complete" in the status panel while the editor's local files quietly stayed on the old schema. The dual-write backend's "swallow shadow failures + flag dirty" pattern (covered by spec 03) is exactly the affordance the gate exploits.

### The recovery branch is the only path that re-pushes unchanged data

Outside recovery, the migration writes only records it actually changed. The recovery decision (`migrated == 0 && skipped > 0` at the locked body) is the sole trigger for rewriting already-v5 content, and only because the only plausible explanation for that state is "shadow lagging from a prior attempt." A redundant write on this path is the price of healing the shadow without operator intervention.

### Pre-v5 data with a v5-shaped transcripts array is rare but must be preserved

A project that ran a v5-aware live writer (live commit pipeline) before its migration ever ran can end up with a record at version 4 carrying an authoritative UUID-based transcripts list. The migration must preserve that list — recomputing via the children-walk would replace the UUIDs with commit hashes that the file-existence filter then drops, silently emptying the array. This corner case is rare enough that it can only arise during the v5 rollout itself, but the guard is permanent.

### The pre-migration head identifier is a triage artifact, never a runtime input

Every successful migration logs the primary backend's pre-migration head identifier to the debug log at info level. Operators who notice a bad outcome can use this identifier to manually point the primary ref back to its pre-migration state. The product never reads this value at runtime; it exists solely for support and triage. The same information is recoverable from the primary backend's reflog (subject to its retention policy), but a single log line is faster to quote in a bug report.

### A v5 record missing the transcripts field is anomalous, not migrated

The fast-path "already v5" check requires both the version marker *and* the transcripts field. A record with version 5 and no transcripts field is treated as anomalous (a bug or hand-edit) and falls through to the recompute branch, repairing it. Without this guard, such a record would force every read of its transcripts list down the legacy children-walk fallback forever — defeating the v5 schema's purpose.

### The no-rename decision turned out to be what keeps migrated memories attributable

Keeping the legacy filenames was justified on blast radius alone: renaming thousands of files in lockstep with every referencing summary compounds the failure modes for no functional gain. What that decision also preserved, unintentionally, is a correspondence between an identifier and a commit hash — and that correspondence is now the only evidence that can attribute a migrated memory's conversations to the individual node whose figures cover them, because the upgrade hoists every identifier to the root and leaves the descendants bare. A rename to opaque values would have been schema-clean and would have made every pre-existing consolidated memory permanently unattributable per node. (Surprising; the cheap choice was also the correct one, for a reason that did not exist yet.)

### The removal routine rewrites descendants but refuses to stamp them

Filtering an identifier out walks the whole tree, because the shape it is called on is the one where the root's list is short and a child still lists the identifier. But it stamps only the root's version marker and identifier field. Bumping a child's marker would assert that a migration touched it, which no migration ever does — descendants are left at whatever schema they were written under, and nothing routes a read off that value. A child with no identifier field is likewise left without one rather than given an empty array, since the absence is the marker for "pre-upgrade, nested". (Surprising; the asymmetry between root and descendant is deliberate in both directions.)

### Reference identity, not set size, is how a caller learns a write happened

The removal answers with the input reference when it changed nothing, and callers key off that rather than off how many identifiers they asked to remove. The one case where "the filter removed nothing" still counts as a change is a pre-upgrade record with a non-empty file-backed identifier set — writing it *is* the upgrade, so it must not report itself as a no-op. A pre-upgrade record with an empty file-backed set has nothing to upgrade and nothing to remove, and correctly reports no change. (Notable.)

### Live writers and the migration must agree on the file-existence filter

The same "intersect children-tree hashes with existing transcript files" rule that the migration uses to build the v5 transcripts list is also used by every live write path (amend, squash, rebase pick, one-to-one migrate, many-to-one merge) — and by the removal routine's pre-upgrade branch — when materializing an authoritative v5 transcripts array from a possibly-legacy input. Without alignment, a squash or rebase of legacy data would bake "dangling" commit-hash IDs (commits that never had an AI session) into the new v5 record's authoritative array, violating the contract that every ID in the array has a backing file at the time the array was written.

### Lock contention is documented, not engineered around

A long-running migration can starve the live commit pipeline for up to about thirty seconds, after which the live writer's queue entry is dropped (its fire-and-forget contract). This is a known trade-off, documented in the migration's internal notes, and not mitigated by finer-grained locking. The expected migration duration on real projects is well under that bound; the worst observed wall-clock for the first v5 migration was driven by per-file subprocess overhead on one platform, which the batch-read primitive addresses.

### The repair stamp is an idempotency key that doubles as a provenance signal

A v5 root's optional repair stamp is not decoration. It is what stops a second repair run from treating an already-repaired summary as a candidate again and minting a second transcript artifact for the same evidence window. The same field is what three display surfaces key off to say a conversation was recovered from local transcript history rather than letting the user read it as live capture. It is additive with no schema bump, in the same way other post-v5 root fields have shipped, and the migration's v5 fast path passes a stamped record through untouched. (Notable; one field, two jobs.)

### The status record schema is versioned independently of the summary schema

The state record itself carries a "schema version of the state record" field set to a constant integer. This is independent of the summary schema version it tracks. A future revision of the state record format can flip this number and route old readers through a tolerant fallback while new readers parse the new shape.

## Shared Behavior

- **Orphan-branch summary storage (spec 01)** — the primary backend the migration reads from and writes to in primary-backed modes; the listing, batch-read, and atomic-batch-write primitives the migration depends on.
- **Folder-based summary storage (spec 02)** — the alternative backend the migration reads from and writes to in shadow-only mode; the per-file read fallback the migration uses when the batch-read primitive is absent.
- **Dual-write summary storage (spec 03)** — the wrapping backend that fans content writes out to both primary and shadow, swallows shadow failures, and exposes the "dirty" signal the migration gates the completion marker on.
- **Summary tree structure (spec 04)** — the unified-hoist root contract, hoist invariants, and children walk that the "normalize to v4" helper preserves and that the legacy transcripts-list fallback relies on.
- **Summary index format (spec 05)** — the index that the migration deliberately leaves untouched because the v5 upgrade is in-place.
- **Summary schema migration (spec 06)** — the prior-version chain (legacy flat-records → unified hoist, legacy index version flip) that runs before the v5 step in the operator-issued migrate command; spec 06's "v3 → v4" collapse is invoked as a sub-step of the per-record upgrade here.
- **Shared write lock** — the coarse-grained orphan-write lock that serializes the migration against the live commit pipeline and other migration attempts.
- **Live commit / amend / squash / rebase pick pipelines** — the writers that allocate fresh UUIDs for new transcripts at write time and apply the same file-existence filter the migration uses when constructing authoritative v5 transcripts arrays.
- **The diagnostic command's transcript repair (a neighbouring topic)** — the one non-pipeline allocator of a fresh v5 identifier, and the only writer of the repair stamp. It creates the identifier's transcript artifact in the same store call as the summary, so it needs no file-existence filter; its candidate selection, its bounds, and its refusal rules are that topic's, not this one's.
- **Per-node usage attribution ([333 — Conversation Usage Recomputation from Transcripts], restated in [306 — Conversation Detach Usage Correction])** — the rule that reads the shape this migration leaves behind: which single node's figures cover an identifier, why a root listing one does not mean it owns it, and why a node whose commit hash equals the identifier is evidence in its own right. Those specs also own the two callers of the removal routine described here, and the outcomes they report around it.
- **The memory panel ([109 — VS Code Summary Webview Panel])** — the surface that supplies the file-backed identifier set the removal's pre-upgrade branch uses, and the only host that invokes the removal today.
