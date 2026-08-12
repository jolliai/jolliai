# 345. Orphan Branch Cutover Fence and Compare-and-Swap

## Topic Statement

Freeze a repository's parallel summary ref permanently with a per-clone marker in its profile, then record the switch to the database as the system of record only inside a locked compare-and-swap that proves, against pinned ref tips that have not moved, that the database already holds everything the frozen ref does.

## Scope

**In scope:**

- The freeze marker's shape, its per-clone scope, and the ordering rule that materializes the user's own opt-out alongside it.
- Everything that changes behavior once a marker is present — enumerated site by site, including the two last-line refusals on the ref-backed write batch and the several places whose reconciliation is downgraded.
- The one-way rules: never auto-revoked, never re-seeded after freezing, never rolled back from frozen-but-unrecorded.
- The compare-and-swap protocol end to end: admission on installed surface versions, source collection, tip pinning, import, seed legality, the containment compare, the fence writes, the locked critical section, and the recording transaction.
- The retry model, what counts as a retry-worthy condition, and the outcome when retries are exhausted.
- Every outcome the protocol can report and what each one means about the repository's resulting state.
- What triggers the protocol automatically, and the per-clone throttle that bounds it.
- The post-swap drift probe: what it compares, what it repairs, and what it deliberately never updates.

**Out of scope (boundaries):**

- The routing decision that reads the marker and the recorded row, and the backends each state yields — covered by **Cutover Routing State Table** (344).
- The machine-global memory database's schema, migrations, and general contents; only the two state rows this protocol writes are described here.
- The import that fills the database from a pinned ref, and its per-mode reconciliation rules; this spec states only which mode is legal when, and why.
- The advisory file lock the critical section takes — its on-disk convention, staleness ceiling, and the re-entrancy registry the one sanctioned bare acquire opts out of — covered by **Lock Primitive Registry** (297).
- The repository profile's other fields and the durable manual-disable decision they encode (spec 145), beyond the ordering rule and the enable path's refusal to clear the marker.
- Per-source version selection and what makes an installed surface "available" for the admission check.

## Data Contracts

### The freeze marker

An optional record inside the per-repository profile document, anchored to the main working-tree root and therefore shared by every linked worktree of one clone:

| Field | Meaning |
| --- | --- |
| reason | Free text. The protocol writes the literal `cutover to sqlite`. |
| at | ISO timestamp of the freeze. Used as the protection cutoff by later imports. |
| tips | Optional. The pinned ref tip per source root, as of the moment the marker went up. |

It is **per clone**, so a repository with two independent clones gets two markers, and a clone made after the freeze gets none.

### The recorded swap

Two rows in the machine-global memory database, keyed by the repository's identity and written in one transaction:

- `cutover` — the state record (frozen tips per source root, an incrementing version, an ISO commit timestamp, and a schema version of 1).
- `cutover-version` — the same version as a bare string, read back to compute the next increment.

### Outcomes

A four-armed result:

| Outcome | Meaning |
| --- | --- |
| `committed` | The transaction landed; carries the state record. |
| `already-cutover` | A row already existed before anything was attempted. |
| `not-ready` | Carries a reason. The repository is in a working state — either still unfrozen, or frozen with the recording pending. |
| `retry-exhausted` | Every attempt found a moved tip or a busy lock. The marker is up; recording is pending. |

### Admission floor

The first release whose surfaces understand the marker: `0.99.9`. Admission is decided from what is **installed on this machine**, not from what has shipped.

## Behavior

### What the marker freezes

Presence of the marker (or, where noted, of the recorded row) changes behavior at these sites:

1. **The ref-backed write batch refuses outright.** Immediately before the plumbing write — after the manual-disable gate — the batch re-reads the marker from disk and throws if it is present, with a message telling the caller its process holds a pre-freeze storage object and must be restarted. Reading from disk at write time is the only thing that can close the window for a long-lived process (an editor host, a server, a worker started before the freeze) that is holding a storage object built when the repository was still unfrozen; no cache invalidation can reach such an object.
2. **The same batch then asks the second witness.** It probes whether a swap has been recorded for this working directory's identity and throws if so, because the marker is per-clone and a clone the swap never enumerated would otherwise write onto a ref nothing will read again. This probe **fails open**: an unreadable or absent database answers "no", so an unfrozen repository is never blocked by a broken database — and therefore a clone with no marker, of a repository that *has* been cut over, can still write the retired ref whenever its database cannot answer. The drift probe below is what catches that.
3. **Storage construction routes elsewhere.** Both frozen states build the database-backed backend as the system of record (spec 344), so newly-constructed storage never reaches the ref at all.
4. **Read resolution routes elsewhere.** Both frozen states read from the database-backed backend, bypassing the retired configuration key entirely (spec 344).
5. **The raw v1→v3 index migration refuses.** Its writes go straight to ref plumbing and therefore miss refusal 1, so it resolves the routing state itself and throws unless the state is exactly `uncutover` — the message names the state and tells the user to migrate before cutting over.
6. **Import reconciliation is downgraded to never-delete.** A fenced source may only be caught up, never seeded: seeding reconciles against the ref's listing, and every memory written to the database during the frozen period is absent from that listing, so a seed would delete them permanently against a ref that will never list them again.
7. **The import's prune re-checks both witnesses at the last moment.** Its mode was chosen from a read taken before a sweep that can run for minutes, so immediately before pruning it re-reads the marker *and* the recorded row; if either now says frozen, the prune is skipped with a warning.
8. **The database back-fill sweep picks its mode the same way.** A marker forces catch-up; so does a recorded row with no marker on disk (warning: the profile was probably wiped), and so does a count of stored memories the pinned tip does not list.
9. **The visible-Markdown heal refuses to drop manifest rows.** Dropping is permitted only in the `uncutover` state, because past the freeze the ref can no longer re-source a row whose backing file is gone.
10. **Old runtimes stop entirely.** The marker's presence is one of the two inputs to the derived composite that already-shipped runtimes read as "this repository is disabled" — which is exactly the intent, since such a runtime would otherwise keep writing the frozen ref. Current runtimes read the user's authored opt-out instead and keep working. (Spec 145 owns this field and its precedence.)

### The ordering rule when the marker is written

Writing the marker first resolves the user's own opt-out to a real boolean and materializes it **in the same locked write** as the marker. Without that, a profile that never recorded an authored opt-out would end up with a composite that is true because of the marker alone, and the next migrating read — finding no authored field and falling back to the composite — would fold the marker's truth onto the authored axis, permanently recording an opt-out the user never made. The materialization is absence-only, so a value a concurrent explicit enable or disable just persisted still wins.

### One-way rules

- **The marker is never auto-revoked.** There is no unfreeze. Old clients must never write the frozen ref again.
- **The enable path must not clear it.** The writer of the authored opt-out is deliberately blind to the marker: clearing it there would simultaneously unfreeze the ref for every old runtime on the machine. Enable clears the authored field only; the composite therefore stays true for a marked repository even after the user re-enables.
- **A frozen-but-unrecorded repository never goes back to preparing.** It is not a failure state — it writes the database and reads the database — and resuming only has to finish the recording.
- **After the marker, gap-fill is catch-up only, and the compare criterion is containment.** The database legitimately grows rows the frozen ref never saw.

The marker's writer does accept a removal request, which deletes the field and recomputes the composite. **No production caller passes one at HEAD** — the arm exists for an explicit manual repair path and is unreached. (Unreachable.)

### The protocol

Given a working directory:

**Admission.** Enumerate every registered install surface on this machine that is actually **available** (an entry pointing at a deleted directory is a ghost and is skipped — counting one would refuse the swap forever with advice the user cannot act on: upgrade a surface that is not installed). Any available surface below the admission floor — including one whose version cannot be parsed, which counts as too old — makes the outcome `not-ready`, listing the stale surfaces. An older surface would keep writing the frozen ref, so the machine must be clean before the freeze begins.

**Registration.** Resolve the repository's identity and find it in the repository registry. An unregistered repository is `not-ready` with an instruction to enable first.

**Already recorded.** Open the database and check for the state row; if present, the outcome is `already-cutover`. A database whose schema is *ahead* of this build cannot be opened writably at all, and that condition is caught here — on this first open only — and reported as `not-ready` rather than escaping as a crash. If this open succeeds, no later open in the run can hit that condition.

**Source collection.** Enumerate the repository's registered working trees and deduplicate them into distinct **clones** by the canonicalized absolute path of each one's common version-control directory. Canonicalizing matters: the relative form that version control prints for a main working tree is the same bare string in every independent clone, so two unrelated clones would otherwise collide on one key and one of them would silently drop out of the protocol — never imported, never locked, never frozen, and still writing the frozen ref afterwards. A working tree whose common directory vanishes mid-scan is dropped rather than allowed to fabricate a collision. The surviving clones are returned in **sorted key order**, which is the lock-acquisition order, so two concurrent runs cannot deadlock on each other's half-taken lock set. No live working tree at all is `not-ready`.

**Resume detection.** For each clone, read its marker; a present one records that clone as already frozen, together with its freeze timestamp. This is checked per clone, not just at the caller's directory, because an earlier run can have frozen some clones and failed before the rest — resuming from any one of them must still notice and freeze the others rather than complete the recording half-frozen.

Then, for each attempt (the first attempt plus a retry budget of three):

1. **Pin every clone's tip.** A clone with no parallel ref is `not-ready`. All subsequent reads of that clone go through the pinned commit, never through the ref name.
2. **Decide seed legality.** Seeding — the mode that reconciles, and therefore deletes — is legal only when **no** clone is frozen and there is exactly **one** clone (a prune reconciles against one listing, so a second clone's memories would look deleted). Even then it is checked against the database: if the database holds memories the pinned tip's summary listing does not name, seeding would delete them, so the run drops to catch-up with a warning. That count **fails closed** — an error counts as "cannot prove it is safe" and also drops to catch-up. Refusing costs stale rows a later legitimate seed removes; failing open costs every memory written during the frozen period, permanently.
3. **Import every clone at its pinned tip**, in the chosen mode. A clone that is already frozen additionally carries a **protection cutoff** at its freeze timestamp: anything the database stamped at or after the freeze outranks what this import can read, so a resume (or a retry after the freeze) cannot roll a regenerated memory back to its pre-freeze body. An unfrozen clone gets no cutoff and wins, which is the pre-freeze contract. An unparseable freeze timestamp degrades to no protection.
4. **Compare every clone at its pinned tip** by containment — every path the frozen tip lists must read back from the database. Extra paths in the database are never a reason to refuse.
5. **Write the marker into every clone that does not have one**, all carrying the same map of pinned tips. A clone that is already frozen is skipped rather than re-marked (re-marking would overwrite its original pinned snapshot), but every unmarked clone must receive one before the run proceeds — a partially-frozen repository strands the unmarked clones. Any write failure is `not-ready` with "staying in prepare". Once a clone is marked in this run it is treated as frozen for every subsequent retry, so no retry can re-seed it. After the marker lands, the process's route memo is dropped, because the route just moved and later steps in this same process write through the storage layer.
6. **Enter the critical section.** Acquire each clone's ref write lock in the sorted order, with a fifteen-second budget per lock — well above the ordinary background budget, because legitimate writers hold this lock across whole post-generation write sections, and this path is interactive rather than blocking.
7. **Re-verify every tip.** Resolve each clone's ref again; every one must still equal its pinned tip.
8. **Record.** In one transaction, upsert the state row and the version row, where the version is one greater than any previously recorded version for this identity (or 1). Then drop the route memo again and report `committed`.
9. **Release** every acquired lock in reverse order, whatever happened.

**Retry conditions.** Two conditions send the run back to step 1 rather than ending it: a lock that could not be acquired within its budget, and a tip that moved. Both are **ordinary** for an active repository, not errors — the log line for each says so. Contention in particular is expected, because the same lock is held across post-generation writes, multi-megabyte transcript batches, and whole index migrations.

**Retry exhaustion.** When every attempt has been spent, the outcome is `retry-exhausted` with a reason stating that the marker is up, writes go to the database, and re-running finishes the recording.

**Failure policy after the marker is up.** Every step that can fail past the freeze returns an outcome rather than throwing: the import and compare on a retry (they run with the marker up and can fail for reasons unrelated to readiness — a schema-ahead database, a concurrent writer holding the database's writer lock past its busy timeout, a version-control read failure), the recording transaction itself, and a repository row that has vanished between the import and the transaction. All of them carry the "you are frozen, writes go to the database, re-run to finish" guidance, because the alternative is a stack trace out of an uncaught command action that never tells the user what state the repository is in.

### The containment compare

For each clone, list the pinned tip under each of these prefixes and read every listed path back from the database: `summaries/`, `transcripts/`, `plans/`, `notes/`, `references/`, `skills/`, `plan-progress/`, `topics/`.

That list is the compare's entire universe. A family missing from it is not merely unchecked — it is invisible, because containment only visits paths the list produces, so an absent family reports success having read nothing.

Per path:

- Byte equality passes.
- Either side reading as absent fails, naming the path as missing from the database.
- A path under `summaries/` additionally passes when it is **shell-equal**: both sides parsed, every nested child list emptied, the remaining bytes equal, and the sequence of child identifiers identical. The database reassembles a summary's children from current child rows, which are fresher than the stale copies embedded in the stored parent file.
- Exactly two synthesized union views — `topics/index.json` and `topics/processed.json` — additionally pass when the database's document **contains** the source's: arrays compared as sets, objects required to carry every key the source has and permitted to carry more, leaves required to be equal. Both are rendered from every row of the identity, and the import folds every clone into that one identity, so for a repository with two clones the database renders the union and byte-equality against either clone's file can never hold. A topic **page** is deliberately not covered by this relaxation — page order is preserved on purpose, and a prefix match here once swallowed every page into the loose compare and certified a reordered page as contained.
- The repository-level index and catalog documents are never compared: they are synthesized views whose entries are covered by the summaries family, and they sit at the tree root rather than under any listed prefix.

The compare reports the number of paths it visited on success.

### Automatic triggering

The protocol runs by itself. It is safe to run unattended because the whole decision is scoped to one device and one repository: the marker is in that clone's profile, the row is in this machine's database, and none of it is pushed, synced, or written to a remote — there is no other machine to coordinate with, so there is nothing for a confirmation prompt to protect.

The automatic wrapper **never throws and never sets an exit code**: every outcome short of a recorded swap is a working state, so a failure here must not turn a successful enable red. It first skips entirely when the runtime cannot load the database module unflagged, then short-circuits on `cutover` (done) and on `blocked` (the repository needs recovery, not another attempt). It reports the state the repository ended in, for logging only — never for control flow.

Three callers:

| Caller | Throttled |
| --- | --- |
| The post-commit queue drain, after a run in which summaries landed | Yes |
| The dashboard history import | No |
| The dashboard command's own start path | Yes |

The unthrottled caller is the one moment the database is known to have just been filled from the ref, which is when the containment compare is most likely to pass and when the user is already waiting on setup. The throttled callers suppress a repeat attempt for **six hours** after the last one, because the compare reads every file the frozen tip lists and a repository that keeps answering `not-ready` would otherwise pay that sweep on every commit and every dashboard reopen.

The attempt timestamp is stamped into the profile **before** the attempt, not after, so a run that dies partway still spends its slot — otherwise a repeatedly-crashing compare would re-run on every single commit. It is only a throttle: neither witness ever consults it.

The queue drain's call sits deliberately **after** its ingest phase rather than between the lock releases and the successor spawn. The storage object for that run was resolved while the repository was still unfrozen; landing the marker first would leave the ingest writing through that stale object, whose ref write batch re-reads the marker and throws — discarding the ingest's model work, leaving its queue entries undeleted, and making the next worker redo it.

### The drift probe

The post-swap safety net for a writer that bypassed the freeze — an old client, or a host that was never restarted.

It reads the recorded state row through a **read-only** database handle and tolerates a database this build cannot open: a writable open would migrate the schema as a side effect of a diagnostic, and on a database a newer surface already migrated every writable open throws. An absent or unreadable database, or an identity with no recorded row, means "no drift to report".

For each recorded tip:

- A source root that no longer exists on disk is **skipped**, not reported. A working tree removed after the swap leaves its recorded tip unresolvable forever, and reporting that as a bypass made the probe fail on every run with nothing the user could do about it. Drift means the ref *moved*, which only a present checkout can tell you.
- A current tip equal to the recorded tip passes.
- Anything else is drift: it is reported, logged as "someone bypassed the fence", and — when the tip resolves and the repository is registered — **catch-up imported at the drifted tip**, so the stranded memories are not lost. The import carries a protection cutoff taken from the clone's own marker, falling back to the recorded swap timestamp when that clone's profile is gone **or** its stamp does not parse (and to no protection when neither timestamp parses), because the bytes on a drifted tip are whatever the bypassing writer put there and importing them unprotected would roll back everything the database stamped since the freeze.
- **The recorded tip is deliberately never updated.** Drift keeps being reported on every subsequent probe until a human deals with the writer; refreshing it would make the next probe read "all clear" while the bypassing writer is still live.

The probe's command surface prints one line per drifted source and sets a failing exit code when anything drifted.

## State Transitions

Per clone and per identity:

- **unfrozen → frozen** — the protocol wrote this clone's marker. One-way; nothing revokes it automatically and no production path passes the removal request.
- **frozen, unrecorded → recorded** — the transaction landed. Reported as `committed`.
- **unfrozen → recorded, for a clone that has no marker** — another clone of the same remote completed the protocol. Such a clone is `cutover` from the routing table's point of view (the row outranks the marker) but has no local marker, so its ref write batch is refused by the second witness alone — and is *not* refused whenever the database cannot answer.
- **frozen, unrecorded → frozen, unrecorded** — a retry-exhausted or post-freeze `not-ready` run. The repository keeps working: writes go to the database and reads come from it. A later run finishes the recording.
- **prepared → prepared** — a `not-ready` before any marker was written (stale surfaces, unregistered repository, no ref, a failed compare). Nothing was frozen and nothing changed.

## Notable Behavior

- **Freezing is one-way and has no revoke.** The removal arm exists in the writer and no production path reaches it. The only revocation contemplated anywhere is an explicit manual repair. (Notable; unreachable arm.)
- **Enable deliberately cannot unfreeze.** The re-enable path clears the user's own opt-out and leaves the marker, so a re-enabled repository still stops every old runtime. Making enable clear the marker would unfreeze the ref for every old runtime on the machine at once. (Notable; central.)
- **The second witness fails open, so a marker-less clone of a cut-over repository can still write the retired ref.** Whenever the database is missing, ahead, or unreadable, the probe answers "not recorded" and the write proceeds. This is the deliberate trade — an unfrozen repository must never be blocked by a broken database — and the drift probe exists precisely to catch its consequence. (Surprising; intentional, with a compensating control.)
- **The drift probe repairs the data and refuses to clear the alarm.** It imports the stranded memories but never advances the recorded tip, so the same drift is reported on every subsequent run until the bypassing writer is found. (Notable; intentional.)
- **Contention is a retry, not an error.** A busy ref write lock is treated exactly like a moved tip. Throwing there would escape the protocol's result contract and crash the command *after* the marker is already up, with none of the "you are frozen, re-run to finish" guidance — which is the one outcome the whole post-freeze failure policy exists to prevent. (Notable.)
- **Retries are the normal path for an active repository.** The critical section is one ref resolution per clone plus one transaction — milliseconds — but any commit landing during the run moves a tip and costs an attempt. (Notable.)
- **The critical section holds several different clones' locks at once, and is the one sanctioned bare acquisition of that lock in the tree.** It cannot be expressed by the re-entrancy-registering wrapper without one nesting level per clone. It is safe unwrapped because it is always top-level and performs no ref write inside — one ref resolution per clone and one database transaction. (Notable; the exception that proves the wrapper rule in 297.)
- **Seed legality is decided from two witnesses plus a count, and every uncertainty refuses.** The marker alone is not sufficient evidence because the profile fails open on a wiped or corrupt file, and per-project state is exactly what users delete. An error counting the database's unlisted memories also refuses. Every refusal costs stale rows; every wrong permission costs memories permanently. (Notable.)
- **The compare's family list is the compare's entire universe.** A family left off the list reports success having read nothing, which once brought archived skills within one release of being certified and then unreadable. (Surprising; the failure mode is a silent pass, not a miss.)
- **Two documents get a looser criterion, and a near-miss of that relaxation was itself a bug.** The two synthesized topic union views must be compared by containment because the database renders the union of every clone while each clone's file holds only its own half — byte-comparing them made a two-clone repository answer "not ready" forever. Matching them by path prefix instead of by exact name swallowed every topic page into the same loose compare and would have certified a reordered page. (Notable.)
- **Admission is decided by what is installed here, not by what has shipped.** A surface below the floor on this machine refuses the swap for every repository on it, because such a surface would keep writing the frozen ref. An install record pointing at a deleted directory is skipped rather than counted, since it can never be upgraded. (Notable.)
- **The version counter increments across repeated swaps.** The row is upserted, so a subsequent recorded swap for the same identity bumps the version rather than failing. (Notable.)
- **The automatic trigger is unconditional and unconfirmed.** There is no prompt and no opt-in; the switch is pressed from the post-commit drain and from the dashboard command. Its justification is scope — one device, one repository, nothing pushed anywhere. (Surprising; deliberate.)
- **The attempt is stamped before it runs.** A crashing attempt still burns its six-hour slot. (Notable; intentional.)
- **The queue drain cuts over after its ingest, not before.** Freezing mid-run would make the run's own already-resolved storage object throw on its next ref write and discard the ingest's work. (Notable.)

## Shared Behavior

- The routing states the marker and the recorded row produce, the closed set of conditions that make the database unanswerable, and the backends each state yields on the write and read sides are defined by **Cutover Routing State Table** (344).
- The short-lived route memo this protocol drops at both transitions, and the difference between resolving the system of record and resolving read storage, are defined by **System-of-Record versus Read Storage Resolution** (346).
- The ref write lock's on-disk convention, staleness ceiling, ownership-checked release, and the call-chain re-entrancy registry that this protocol's bare acquisition deliberately opts out of are defined by **Lock Primitive Registry** (297).
- The ref-backed write batch's two last-line refusals, and the plumbing they guard, are defined by **Orphan Branch Summary Storage**.
- The repository profile file, the authored opt-out, the derived composite this marker feeds, and the ordering rule that materializes the authored field alongside the marker are defined by **Repo-Wide Manual Disable Flag** (145).
