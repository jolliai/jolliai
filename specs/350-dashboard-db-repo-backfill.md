# 350. Dashboard Database Repository Backfill

## Topic Statement

Bring the machine-global memory database up to date from every registered repository by set reconciliation — upsert what the repository currently has, delete what it can no longer reach, and use cursors only to skip work that provably cannot have changed.

**This is not the historical memory back-fill.** A different feature of the same name (see **CLI Back-fill Command**, cross-ref 214, and **Back-fill Engine Orchestration**, cross-ref 227) attributes past conversations to commits and spends model budget generating memories for them. The pass described here never calls a model, never creates a memory, and never reads a conversation for content: it copies facts that already exist — git history, already-stored memories, already-discovered sessions — into local database rows. The two share nothing but the word.

## Scope

**In scope:**

- Which registered repositories the pass runs for, and how one with no checkout left on disk is answered.
- The per-repository order of work, and which tiers are cursor-gated versus re-projected every time.
- The four cursor keys, what each is computed from, and what each one is (and is not) allowed to decide.
- The commit tier: multi-checkout collection, the exclusion of this product's own storage references from every git-side read, **branch attribution as a single recorded value rather than a reachability set**, the merge before writing, the projection-skip comparison, the prune and the two sets of cached calendar days it has to invalidate by hand, the per-file statistics skip rule, and the bisect that salvages a failed statistics batch.
- The memory tier's content-hash gate, the per-event projection-skip comparison beneath it, and the completeness condition on advancing the cursor.
- The session and worktree tiers, which run unconditionally.
- The memory import's mode decision — when reconciliation is legal, and the two database-side witnesses that demote it.
- The bootstrap flag's three values and when each is written.
- The per-repository result record, the ordering of the returned list, and error isolation.
- The write-ahead log retention pass that rides the end of each repository's pass.
- The per-day rollup settle every batch opts out of, and the single settle that runs at the end of a repository's pass instead.

**Boundaries (consumed here, owned elsewhere):**

- The registry of enabled repositories, the identity derived for each, and the recorded checkout list are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355). This pass reads entries and never prunes them.
- The freeze marker whose presence makes reconciliation illegal, and the compare-and-swap that records a completed switch, are defined by the **Orphan Branch Cutover Fence and Compare-and-Swap** topic (cross-ref 345) and the **Cutover Routing State Table** topic (cross-ref 344).
- The memory import itself — which row families it writes, how it orders them, what it deletes in reconciling mode — is owned by the memory source-of-truth topics. This pass decides the import's *mode* and *protection floor* and consumes its row counts.
- The import's stored lifecycle record and resume cursor are defined by the **Orphan Import Lifecycle and Resume Cursor** topic (cross-ref 351).
- The per-day rollup cache this pass invalidates and settles — what a cached day holds, which write stamps mark one stale, and the sentinel that records a settled day — is owned by its own neighbouring topic. This pass owns only the two moments it has to speak to that cache: a prune, and the once-per-pass settle.
- The projection layer that turns a collected event into rows, the write-ahead log it lands in first, and the event schema are owned by the store-and-schema topics. Two of its rules are load-bearing here and are stated where they bite: an **absent** field means "leave the stored value alone" while an **empty** one is the positive claim "nothing"; and every projection is an idempotent upsert, which is what makes a redo harmless.
- The terminal rendering of the result list (headers, per-repository lines, the migrated-memories tally) belongs to the launcher/enable command surface. This spec defines the result records that rendering consumes.
- Session discovery per source, transcript reading, and per-model pricing are owned by their own topics; this pass consumes whatever every discoverer returns, without the sidebar's hidden/unread/recent filters.

## Data Contracts

### Where the pass runs

Never in the read-only HTTP service. Only in a command process — the dashboard launcher and the enable path both call it — and both feed the same projection the live producers use, so an imported fact and a live-written fact are indistinguishable in the database once written.

### Cursor keys

Four keys in `ingest_cursors`, keyed per repository identity:

| Key | Value | What it gates |
| --- | --- | --- |
| `git-commits` | one entry per surviving checkout, `<path>@<value>`, sorted and space-joined. Each checkout's value is its HEAD hash, plus `+` and a hash over that checkout's local branch tips with this product's own storage refs filtered out. A failed branch-tip read degrades that checkout to its HEAD hash alone | skips the whole commit collection when unchanged |
| `summaries` | a hash of the memory index's JSON content | skips the memory-tier collection when unchanged |
| `sot-import` | the pinned ref tip, `#`, and the mode this pass chose (`seed` or `catch-up`) | skips the memory import when unchanged |
| `sessions` | the largest session update stamp seen | **nothing** — written for observability only, never consulted |

Two properties are deliberate. HEAD alone is not the commit signal: deleting a branch, rebasing it, or committing from another checkout moves no HEAD this pass can see, and a HEAD-only value would call that unchanged and skip both the prune and the attribution refresh indefinitely. And this product's own storage references are excluded — by the same rule the commit collection applies (see *The storage-reference exclusion* below) — because that reference gains a commit on every memory write: including it meant the value could never converge on a repository that is actually in use, so every launch re-swept the whole history the cursor exists to skip.

The mode rides in the import cursor because a repository that gains a second checkout (or a freeze marker) changes mode with the ref tip standing still, and the two modes do not write the same rows.

### Bootstrap flag

`repos.bootstrap_state`, read per repository, defaulting to `pending` for one the database has never seen. A pass where the value is anything other than `done` is a **bootstrap**: all three cursor gates are bypassed, and the commit phase marker carries a first-run flag the caller uses to decide whether to warn about a long wait. The per-file statistics skip set is *not* gated on this — it is computed the same way on every pass (see below) and is simply empty on a first-ever sweep, because no commit has file rows yet.

### Per-repository result

- **mode** — `bootstrapped` (this pass completed the repository's first sweep), `recovered` (an incremental pass), `skipped` (the pass threw), `unavailable` (no registered checkout exists on disk, so nothing was attempted).
- **events applied** — the count the projection accepted this pass.
- **repository name** — present on every result, including the two failure kinds, so a caller can name it.
- **import row counts** — the memory import's per-family counts; absent when the repository was never swept and when there was no read source to import from.
- **error** — set only on `skipped`.

**The conversation tier reports its own summary line, and states both counts outright rather than as a ratio.** It names how far back it looked, how many conversations it read, how many it skipped, and which agents the read ones came from. *Read* and *skipped* deliberately **need not add up to** *discovered* — a conversation whose instant cannot be parsed is discovered and neither — so a "18 of 24" phrasing would ask the reader to subtract and would give them the wrong answer if they did.

`skipped` and `unavailable` are different words for different facts on purpose: the first is a failure to report against the repository, the second is a repository that is not here right now. A caller that renders them identically turns an unmounted drive into "migration failed".

### Progress record

Emitted per repository, and re-emitted by the multi-repository driver with a 1-based index and the count of repositories actually being swept (the dropped ones are not in that denominator).

- **kind** — `commits`, `summaries`, `memories`, `sessions`.
- **done** — items completed; **`done: 0` is a phase-start marker emitted before the work begins**, which is the only event the slow phases can offer, since a whole-history git scan is one opaque subprocess.
- **total** — absent on phase-start markers, and absent for a memory pass whose index could not be read (no denominator exists).
- **detail** — qualifier on a phase-start marker, used to name which checkout is being scanned when a repository has more than one.
- **first run** — set on a `commits` phase-start marker only when this repository has never completed a bootstrap.

### Batch size

Collected events are applied **200 at a time**, and each batch takes the database's single writer lock more than once (the durable log write commits on its own, then the projection runs). Small on purpose: a hook or an editor tick may be waiting on that lock, and one whole-import transaction would starve them for the length of the import.

**Every batch also opts out of the per-write rollup settle.** One pass reaches the batch applier about a dozen times and runs hundreds of batches through it, and each batch's writes mark the days it just touched stale — so left on, the pass rebuilds the same newest days once per batch (measured at ~945 ms for a fourteen-day settle) and keeps only the last rebuild. It settles **once** instead, at the end of the repository's pass and against the state that pass finished in. The settle is quiet and derived, so a failure there costs a slower page and never the backfill. The two callers on this path that write only registry rows settle nothing at all, since no spend axis reads those rows.

## Behavior

### Selecting repositories

The driver is given the registry's active entries (the caller filters out ones the registry marks disabled) and walks them one at a time. Before sweeping, each is tested for **any** recorded checkout still existing on disk.

A repository where none does is **dropped before the sweep** and answered with an `unavailable` result. It is not deregistered: the same evidence covers "temporarily unmounted" — a network share, an external drive, a checkout being recreated — and forgetting the registration on that evidence would throw it away for a directory that comes back. The entry is picked up again the moment a path exists.

**The only explanation of *why* it was dropped is emitted at debug level** — naming the repository and the missing path — which the command-line runtime suppresses from the terminal, and which its default file threshold also drops. The result record is therefore the sole carrier of the fact: if the caller does not surface it, nothing does. *(Notable — see below.)*

Each repository is swept inside its own error boundary; a repository that throws produces a `skipped` result carrying the message and the loop continues. The returned list is the swept repositories in order, with the dropped ones **appended** at the end.

### Per-repository preparation

Before any database handle is opened:

1. Enumerate every recorded checkout that still exists, **newest first**. Identity is the normalized remote, so two clones of one project share one entry — sweeping only the primary path would silently ignore the other clone's commits and branches. The first entry is "the" checkout for anything that must pick one: the cursor-bearing reads, the memory index, sessions (recorded per project, not per checkout) and the worktree state.
2. Resolve the parallel memory ref to a **tip commit** and pin a read source to that exact tip. Reading by ref name instead is a race: a writer advancing the ref mid-pass would make the run see a mixture of two versions, and a reconciling import would then delete rows for paths that merely do not exist at the older tip it listed. A test seam may supply a read source directly, in which case no tip is resolved.
3. Read the freeze marker from **every** surviving checkout, not just the newest, taking the earliest datable one. A repository frozen in one clone and later cloned again answers "not frozen" to anyone who asks only the newest checkout — and the protection floor derived from the marker has no other witness, so missing it silently turns the import into an unprotected one, which does not skip a stale body but writes it over the fresh one.

All three reads happen *before* the database handle is opened, so none of them runs inside the handle's lifetime.

### Projecting the registry entry

The first thing written is the repository's own row, so every foreign-key target exists with a real name before any child row references it. It is projected **as enabled, unconditionally** — the pass has no branch that honours a disabled marker (a separate, cheap registry projection exists for that and is what a long-lived server mutating the registry over HTTP calls).

### The commit tier

Skipped entirely when this is not a bootstrap, a git cursor could be computed, and it equals the stored one. Otherwise:

1. Read, **once for the whole checkout loop and before any of them writes**, the set of commits that already have file rows. Re-reading per checkout would let the first checkout's upserts mark the second one's commits as known and skip their file scan.
2. For each checkout in turn, emit a phase-start marker (qualified by checkout when there is more than one) and collect one event per commit reachable from the checkout's local history — every local branch except this product's own storage references, plus the explicitly named checkout head so a detached checkout (mid-rebase, mid-bisect) is not invisible. Deliberately not every reference the repository holds: remote-tracking references and tags would make a commit living only on a colleague's fetched branch, or on an old tag, count as this machine's work *and* display with no branch at all, because the local-branch enumeration could never explain where it came from. Each event carries the hash, committer timestamp, subject, author name and email, the branch the memory recorded for it when one exists, **that same branch restated as a one-element attribution list**, per-file insertion/deletion counts, and the root diff totals the memory index carries. Note that the *commit set* is still reachability-derived — it is the per-commit *attribution* that no longer is.

The attribution field has **three states, and they are not interchangeable**: **absent** when no memory index could be read at all, meaning "leave whatever is stored alone"; **empty** when the index loaded but records nothing for this hash, which the projection honours by **deleting** the commit's attribution rows; and a one-element list when a branch was recorded. Collapsing the first two would make one unreadable index wipe attribution for every commit in the repository. A checkout whose history read **throws** contributes nothing, is logged at warning level, and marks the collection **incomplete**.
3. **Merge across checkouts before writing anything.** The attribution field is replace-when-present, so applying each checkout's events in turn would leave the last sweep's value as the only one, silently erasing what only the other clone knows. Merging keeps the first checkout's metadata and unions the attribution lists **only when both sides carry one**: absence means "keep what is stored", and coercing an absent side to empty would turn two silences into the positive claim "nothing is attributed", which the projection honours by deleting every link.

**That union is now degenerate and is deliberately kept anyway.** The memory index is per-repository — dual-written identically into every clone — so it is resolved once at the primary checkout, and every checkout therefore reports the same recorded branch for a given hash. The union can no longer combine two different answers, but removing it would remove the absent-versus-empty distinction above with it.
4. Compare each merged event against the stored row and **project only the ones that would change something**. The comparison mirrors the write exactly: nullable columns are written coalesced, so an absent value is not a difference while a present one must match; the committer timestamp is written unconditionally, so it is always compared; a present attribution list must match exactly; and an event carrying file data is never skipped. On a normal day only the handful of commits on the branch being worked on differ, and the count skipped is logged.
5. **Only when the collection was complete**, prune every stored commit not in the merged collected set (the projection's cascades remove its branch links and session links with it) and advance the git cursor. On an incomplete collection both are withheld and a warning names the repository — the writes that landed stay, only this pass's destructive half and its cursor are forfeited. The cursor rides with the prune because it is derived from HEAD plus the ref list, which can resolve perfectly while the history read fails; advancing it on a partial pass would make the *next* pass skip collection altogether, turning a transient read failure into a permanent blank.

**The prune carries one further obligation, and it is the one direction the derived per-day rollup cache cannot work out for itself.** A cached day is invalidated by source rows being *written*, and a delete leaves no write stamp — so the prune has to name the days it destroyed. It names two sets, and the order is what makes each answerable. **Before** deleting, it reads the pruned commits' **own** instants: those are the days each of them stops being counted on, and once the rows are gone there is nothing left to ask. **After** deleting, it asks for each surviving memory's **new** landing day — the commit rows go but their memories stay (a rewritten commit's row is a *duplicate* of the surviving one, kept by design), so each of those memories moves to another calendar day, and an old day gets no further writes to rebuild itself. That second question is asked **through the shared landing expression rather than by restating the rule**: a prune is that expression's *alias* case, and the obvious restatement — the memory's own commit date, which is the author date — drops the middle term, so the wrong day was forgotten and the day that actually changed was not (up to 400 days apart in this repository's own rebase fixture). Asking after the delete is what lets the answer be the post-delete landing without this pass having to know which of the expression's terms wins.

That first read is a **single statement carrying one bind parameter per stale commit**, where the delete beside it still runs one hash at a time. The database refuses a statement past roughly thirty-two thousand parameters, and nothing here catches the refusal — see *Notable Behavior*.

#### The storage-reference exclusion

This product keeps its memories on an ordinary local branch under a reserved reference namespace, and that branch gains **one commit per memory**. Every git-side read in this pass therefore drops it, by one shared rule: the commit walk, the per-file statistics pass, and the change-detection fingerprint the whole tier is gated on. Without it, the memory-storage commits are imported as the user's own work and every commit-derived figure the dashboard shows is dominated by commits about the other commits.

**The rule outlived one of its enforcement sites, and where it still bites has changed.** It used to be pinned by the branch enumeration behind reachability attribution, which no longer exists. It remains live in the change-detection fingerprint, where getting it wrong fails *silently* rather than visibly: a user branch wrongly classified as internal is filtered out of the fingerprint, so commits landing on it never move the cursor and never trigger a sweep. The classification is by reference **namespace**, never by name prefix — an ordinary branch whose name merely begins with the same characters must keep counting — and the bare namespace with no separator is not the namespace either.

Matched by **namespace prefix**, so a retired version of the reference goes with it while a user branch merely *named* like the namespace stays ordinary work.

On the git side the exclusion is a **positional** argument: it applies to the branch enumeration that immediately follows it and is consumed by it, so the order of those arguments is load-bearing. The spelling that looks right — the fully qualified reference path, and the one required when the selector is the repository's whole reference space — matches nothing under a plain branch enumeration and is silently ignored, producing neither an error nor a warning.

**Notable, and reachable:** the exclusion covers only the branch enumeration, never the explicitly named checkout head listed beside it. The justification recorded in the code is that the storage branch is written by plumbing and never checked out — an assertion, not an enforcement. A user who actually checks that reference out gets every memory-storage commit collected as their own work, and the cursor exclusion cannot rescue it because the head is what the fingerprint records in the clear.

#### Branch attribution is one recorded value, not a reachability set

A commit carries **the branch it was committed on**, taken from what the memory recorded for it — a historical fact about that one commit. Where no memory recorded a branch, nothing is attributed, and an empty answer **clears** any stored attribution rather than leaving a stale one behind.

**This is a deliberate reversal of the earlier design, forced by measurement.** Attribution used to be a reachability set, computed by unioning a per-branch history walk over the fifty most-recently-committed branches — a cap that existed purely to bound that fan-out, since the alternative (asking per commit which branches contain it) is one subprocess per commit per branch. Two things were wrong with it, and they compounded:

- **The window was unstable.** Ordering branches by commit date and taking the newest fifty means a commit on *any* branch reshuffles the window. The projection-skip comparison tests the attribution set for exact equality, so on a repository past the cap every commit the window reached was re-projected on every pass and never converged — measured on a 350-branch repository: 11,953 commits re-enqueued per shift and 24.6 MB of duplicate write-ahead rows.
- **A branch falling out of the window deleted its rows**, because the field is replace-when-present. Stored attribution was therefore a moving target under the one query that reads it.

The recorded branch is also the **better answer** for that query. Reachability counted every commit on the base branch under every feature branch based off it, which is precisely why the reader needed an apportioning division in the first place.

**The cost is stated rather than hidden:** "which branches can see this commit *now*" is no longer answerable from this data. That was checked against the questions the dashboard actually asks — cost per pull request, cost per commit — and is needed for neither. The underlying tables are retained and still written, one row per commit, because released clients still read them.
#### The per-file statistics skip rule

The whole-history per-file scan is where this tier's wall clock goes, and it is pure waste for a commit whose file rows are already stored — a commit's diff is immutable.

The skip set is **the commits that have at least one row in `commit_files`** — deliberately **not** the set of stored commit hashes. The two diverge exactly where it matters: when a batch's file scan fails, its commits are inserted anyway (the commit list is what the prune is computed against), so keying the skip off row existence would mark them known and skip their file scan **forever** — the only path that re-scanned everything was a bootstrap, and the bootstrap flag never returns to that, so those file rows stayed missing until someone rebuilt the database. Keying off stored file rows retries them on the next sweep instead.

Two further rules ride on it:

- **Merge commits are excluded from the retry.** The per-file scan shows no diff for a merge, so it has no file rows to find and would otherwise be re-asked on every sweep forever — and in a merge-heavy history, enough of them to overflow the incremental form. A non-merge commit with genuinely no files is **not** excluded, and by the same arithmetic it can never satisfy the file-row probe either, so it is re-asked on every sweep forever too — accepted as one hash in an argument list nobody notices. The same permanence applies to any commit whose diff is too large for the subprocess output buffer: it is not a merge, it will never produce a file row, and the bisect below narrows it down to itself rather than resolving it.
- Above **400** commits still needing a scan, the targeted per-hash form is abandoned for the whole-history one. That is a hard limit, not a tuning choice: the targeted form passes every hash as a command-line argument, and a large enough set does not run slower, it fails to spawn.

Everything else in the collection stays whole-history: the commit list is what the prune is computed against, and reachability changes for *old* commits whenever a branch moves.

#### A failed targeted batch is bisected

The targeted form asks git for an explicit set of hashes in one call, so **one commit can fail the whole call on its own** — a diff larger than the subprocess output-buffer cap is the concrete case, and it is a property of that commit, so it fails identically on every retry. Returning nothing for the batch then denies file rows to every *other* commit in it, and since the next sweep asks which commits have file rows, all of them come back: the same doomed batch, plus whatever new commits joined it, on every sweep for the life of the repository.

So a failed batch is **halved and re-asked breadth-first**. Each chunk that succeeds contributes its file rows; each chunk that fails and still holds more than one commit is split again and queued behind the rest. Breadth-first rather than depth-first because a shallow pass over the whole batch salvages more per call than following one branch down to a single hash, and because it keeps the budget from being spent entirely on whichever half happens to be searched first.

The salvage is bounded at **twenty-four** extra calls, and the bound is what makes it safe to attempt at all: the same failure shape covers both "one commit in this batch is unreadable" and "git is broken in this repository", so a repository that fails every call pays a small flat number of subprocesses per sweep instead of one per commit, forever. A batch of exactly one commit that fails is not bisected — there is nothing left to split.

Both the initial failure and an exhausted budget are logged at **warning** level, not debug, because the commits of a failed batch still land: the line is the only trace that their file detail did not. Emitting nothing for the field is therefore the **terminal** state after salvage rather than the immediate one — the chunks still queued when the budget runs out keep no file rows this sweep and, by the skip rule above, are re-asked on the next.

### The memory tier

Gated on the memory index's content hash — the index is small and rewritten wholesale, so "did anything change" is exactly "did its JSON change". Unchanged (and not a bootstrap) means no memory was added, merged or migrated since the last pass, and the phase marker is **not** emitted; a marker outside the gate made a phase that then did nothing appear on every launch.

On a change the sweep is a full re-read — memories are consolidated, so per-entry cursors cannot work — producing one event per **root** memory (children of an amend or squash tree are superseded history the root already aggregates). Each event carries the memory's per-topic decisions and to-dos, its external references, and its session links resolved through the stored transcripts, with per-model token and cost figures where the source recorded them.

**A per-event skip sits underneath that gate, and it exists because the gate alone is nearly useless on an active repository.** The commit tier's cursor is per-checkout, so an ordinary pass usually skips its collection outright; the memory cursor is the index's *content hash*, which moves the moment any single memory is written and then re-collects the **whole** set. So on a repository under active development the gate is open on essentially every pass and every stored memory was re-logged and re-projected — measured at 219 events in one launch, every copy byte-identical. The redo is idempotent in the database and free in nothing else: it appends a write-ahead row per event and re-runs the projection's writes.

The index hash **cannot** be narrowed to fix this, because consolidation folds children into new roots and per-entry cursors therefore genuinely cannot work — which is why the answer is a comparison per event rather than a finer cursor. Each collected event is compared against what the database already holds and dropped when projecting it would write nothing new. One input to that comparison cannot come from the memory side at all: a memory's session links **seed** session rows, and whether that seed is a no-op depends on the state of the session rows rather than on the memory, so the stored per-session coverage is read once per repository and passed in. An event whose commit row is absent is never treated as unchanged unless that commit was pruned in this same pass.

The cursor advances **only when the collection saw everything and nothing stayed unprojected**. The collection reports itself incomplete when the index could not be read or when any single memory read threw; the batch application reports the absolute backlog of unprojected rows for these repositories at the end of the last batch (overwritten per batch, never accumulated — summing it would make a backlog that one batch reported and the next drained keep a non-zero total forever). Either condition withholds the cursor and logs a warning naming both numbers.

### The session tier

Always re-projected, never gated: a global high-water stamp would miss an old session updated out of order.

**This tier no longer reads only the shared session registry, and the reason is a measured blind spot.** Each per-source discoverer keeps a 48-hour staleness horizon as its default window, which is what the sidebar, the status command and post-commit generation all get by not passing anything. That default must not be widened for generation — a wider window there would write week-old unrelated conversations into a commit's stored memory, persistently, with nothing printed anywhere — so this tier passes its **own 7-day window** instead, held in a module of its own precisely so neither side can be changed by editing the other.

The blind spot it closes was large: measured on a real machine, the registry held 3 conversations for one agent while that agent's own transcript directory held 64. The other 61 conversations — and every skill and tool call inside them — were invisible to the dashboard, because a registry that prunes at 48 hours was the only route to them.

**Sessions may be scanned once across repositories and handed in, and the shape of that hand-off is load-bearing.** Pre-scanned sessions arrive keyed by source tag, and *presence itself* records whether a source was scanned — deliberately, rather than a separate did-I-scan flag beside the results. Two facts that must never disagree cannot disagree when one encodes the other: kept as two fields and reconciled by hand, getting it wrong in either direction was silent, because "this source found nothing" and "this source was never asked" produce an identical empty result. So a source is either scanned twice with every session discovered twice, or skipped with nothing supplied and dropped from the run entirely, with no error either way.

**The distinction that does survive is empty versus absent.** An empty list is the positive claim "the scan ran and found nothing", so the per-repository loader is skipped for that source. Absent means no scan happened and the loader runs. **A caller whose scan failed must therefore report absent, never empty** — reporting empty would silently erase that source from the run.

**One source is added to rather than substituted for.** The registry half of the fan-out carries that source too, as this scan's own fallback, and carries another source that has no other route at all — so the registry loader always runs and the pre-scanned sessions are concatenated onto it, with the dedupe below merging the two views of one session. Every other source's pre-scan replaces its loader outright.

The tier applies none of the sidebar's presentation filters (no hidden-session drop, no unread-only counting, no recency window beyond its own scan window). Entries are deduped by (source, session id) with the newest update winning, then projected with the resolved title, message count, and per-model usage where the source recorded any. The cursor is written afterwards purely as a record of progress, and only when at least one session carried an update stamp.

### The worktree tier

Recomputed every pass, from the **primary checkout only**. The dirty-state row is keyed by (repository, branch), so two checkouts sitting on the same branch would overwrite each other's state, last writer winning — reporting one checkout truthfully beats reporting an arbitrary one of two.

### The memory import: mode decision

The import is a separate pipeline from the event tiers above; what this pass decides for it is its protection floor, its mode, and (in the next section) whether it runs at all.

**Protection floor.** Derived from the freeze marker's stamp when it parses, and from the recorded switch's own commit time otherwise. Without a fallback an import of a frozen source runs unprotected, and the non-reconciling mode does not skip a stale body — it writes it over the fresh one.

**Mode.** Reconciling (`seed`) is legal only when the repository has **no freeze marker** and **exactly one surviving checkout**. Multi-checkout demotes because the import reads a single pinned source — one checkout's ref — while the rows are shared by every clone of the identity, so reconciling would delete the memories only the *other* clone has. The commit tier avoids this by merging every checkout before pruning; the import cannot.

When still legal at that point and a read source exists, **two further database-side witnesses can each refuse it**, and only refuse:

1. **A recorded switch with no marker on disk.** The marker lives in per-project ignored state that a deep clean removes, and its reader fails open — losing it alone would re-legalize reconciliation, whose prune would then permanently delete every memory written since the switch, because the ref it reconciles against is frozen and will never list them. A warning says so explicitly.
2. **Stored memories the pinned tip does not list.** The listing of the source's memory files is compared against the stored rows; any count above zero means something wrote where that ref could not see, which is exactly the state a prune must not run in. A warning names the count. This read is deliberately **not** guarded: a throw aborts the whole repository's pass (a `skipped` result), because the alternative — treating an unreadable listing as "the source lists nothing" — is "prune everything".

Anything that refuses leaves the mode as non-reconciling (`catch-up`). Reconciling and protecting are mutually exclusive by meaning, and the import rejects a call that asks for both.

### The memory import: gate and run

The import is gated on the **pinned ref tip plus the chosen mode**, not on the memory index hash: documents and topic pages change without the index moving, while the tip commit is a hash of the whole tree the import reads, so an unchanged tip means every input byte is unchanged. Convergence is not a reason to re-run it — a converged reconciling pass still rewrites the whole repository's rows.

- **Cursor matches (and not a bootstrap)** — nothing runs. The result's memory count is answered from the database instead of from the zero an absent result would produce, because the caller reports that number and "0 memories" on a healthy repository reads as data loss.
- **Otherwise** — the import runs with the mode, the protection floor and a progress forwarder, and the cursor is written **after it returns**, never before: the import resumes from its own per-batch cursor, and a run killed halfway leaves rows the next pass must still write. Advancing on entry would call that partial state current and freeze it until the ref happened to move again.
- **No read source at all** (no tip resolved and no injected source) — nothing runs and nothing is pruned. A missing ref is either a repository that never had memories or a ref deletion, and destroying rows because a ref vanished would make an accident permanent.

A test seam that injects a read source has no tip, so it is deliberately ungated and its cursor is never written.

### Finishing a repository

The bootstrap flag is set to `done` and the last-ingested stamp written — **unconditionally**, including after a pass whose commit collection failed or whose memory cursor was withheld.

Then the write-ahead log's retention pass runs, inside the handle already held: projected event rows older than **14 days** are deleted, up to **2,000** per pass. This path applies batches directly rather than through the writer entry point that normally carries the retention pass, and the log's event ids are deliberately not unique, so without this a machine that only ever runs the launcher or the enable path would grow the log without bound.

Then, in the same handle, the pass's **rollup settle** — the one every batch opted out of — runs once, against the state the pass finished in.

## State Transitions

### Bootstrap flag

| From | Event | To |
| --- | --- | --- |
| *(no row)* | read | `pending` (default, not written) |
| `pending` / `in-progress` | pass begins | `in-progress` |
| any | pass reaches its end (complete or partial) | `done` |
| `done` | pass begins | unchanged — every cursor gate now applies |

### Import mode, per pass

| Condition (first match wins) | Mode |
| --- | --- |
| freeze marker found in any surviving checkout | `catch-up` |
| more than one surviving checkout | `catch-up` |
| a recorded switch exists in the database | `catch-up` |
| any stored memory is absent from the pinned tip's listing | `catch-up` |
| otherwise | `seed` |

### Result mode

| From | Condition | To |
| --- | --- | --- |
| candidate | no recorded checkout exists on disk | `unavailable` (never swept) |
| swept | bootstrap flag was not `done` at entry | `bootstrapped` |
| swept | bootstrap flag was `done` at entry | `recovered` |
| swept | the pass threw | `skipped`, carrying the message |

## Notable Behavior

- **A repository whose every checkout is gone is dropped silently except for its result record.** The explanation is logged at debug level, which the command-line runtime suppresses from the terminal and, at its default file threshold, does not write to the log file either — so the result record is the only carrier. This replaced a state where such a repository produced three warnings per pass forever (HEAD unreadable, then collection failed, then prune skipped); the record exists so the caller can say it once instead. Nothing prunes the registry, so these entries accumulate and are re-tested on every pass. (Notable; the caller is load-bearing.)
- **A failed sub-read forfeits the cursor, not the writes — so the whole collection repeats on every later pass.** One unreadable checkout withholds the commit prune and the git cursor; one unreadable memory (or one unprojected row) withholds the memory cursor. The rows that did land stay, stale rows survive un-pruned, and the next pass re-collects everything again. Each forfeiture is announced at warning level, which *does* reach the terminal — unlike the dropped-repository case above. The alternative was measured and is worse: advancing a cursor after a partial pass makes every later pass skip collection outright, which for the memory tier means a memory that failed to read once is missing until the index itself happens to change. (Notable.)
- **The per-file statistics skip is keyed off stored file rows, not stored commits.** A commit whose file scan failed is stored without file rows and comes back on the next sweep; keying off the commit row instead marked it known and made the gap permanent, because only a bootstrap re-scanned everything and the bootstrap flag never returns to that state. Merge commits are excluded from the retry, since they have no file rows to find and would be re-asked forever. (Notable; this distinction is the entire self-correction.)
- **Two classes of commit are re-asked for their file statistics on every sweep, forever, and nothing reports it as a problem.** A non-merge commit with genuinely zero files cannot satisfy the file-row probe, so it never leaves the set needing a scan; the same holds for any commit whose diff overruns the subprocess output buffer, which the bisect can isolate but never read. The cost is a hash in an argument list and, for the second class, one failed call per sweep. (Surprising; the alternative — treating "asked and got nothing" as done — is what made a transient failure permanent.)
- **A history rewrite large enough to strand roughly thirty-two thousand commits makes the pass throw, and it never converges.** The prune reads the pruned commits' instants in one statement with **one bind parameter per stale commit** — the code it replaced deleted one hash at a time and had no such ceiling — and the database refuses a statement past that limit. Nothing catches the throw: the repository is reported `skipped` **with its cursor withheld**, so every later sweep re-collects the same set and fails identically, for the life of the database. The only trace is one skipped line. (Surprising; a live defect, and the withheld cursor — normally the thing that makes a failure self-correcting — is what makes this one permanent.)
- **The rollup settle is switched off per batch and run once per repository pass.** Every batch marks the newest days stale, so settling per batch rebuilt the same days hundreds of times and kept only the last rebuild. The single end-of-pass settle is quiet and derived — its failure costs a slower page, never the backfill. (Notable.)
- **A prune has to tell the per-day rollup cache what it destroyed, and it asks the two questions on opposite sides of the delete.** Staleness is otherwise detected from write stamps and a delete leaves none, so the days a pruned commit stopped counting on are read *before* the rows go, and each surviving memory's new landing day is asked *after* — through the shared landing expression, because a prune is that expression's alias case and restating the rule forgot the wrong day. (Notable.)
- **This product's own storage references are excluded from every git-side read except the explicitly named checkout head.** The commit walk, the statistics pass, the branch enumeration and the change-detection fingerprint all drop them, because the storage branch carries one commit per memory and would otherwise be imported as the user's own work and outrank the primary branch in attribution. The head is exempted on the strength of an assertion — that branch is written by plumbing and never checked out — so a user who does check it out gets every memory-storage commit collected. (Notable; reachable.)
- **A failed targeted statistics batch is salvaged by bisection, under a fixed extra-call budget.** One commit whose diff cannot be read used to deny file rows to every other commit beside it, and because the retry set is computed from stored file rows, the same doomed batch came back on every sweep for the life of the repository. Halving isolates the poison; the budget keeps a repository where *every* call fails from spending a subprocess per commit. Emitting nothing is now the terminal state after salvage, and the warning is the only trace, since the commits themselves still land. (Notable.)
- **Branch-list truncation is detected by the list being longer than the cap, not by asking git for one more than the cap.** The full list is fetched and capped in the consumer *after* the storage references are filtered out, because those sort first by commit date essentially always — asking for one past the cap would spend a slot on a reference that is never walked. Enumerating names is cheap; the per-branch reachability walk is what the cap protects. (Notable.)
- **A demoted repository never deletes anything.** Every demotion path lands on the non-reconciling mode, which is pure upsert — so a memory genuinely removed from the source lingers in the database until a pass that is legally reconciling runs. That is the deliberate asymmetry: a wrong reconcile deletes permanently, a wrong catch-up leaves stale rows a later pass removes. (Notable.)
- **Two of the mode witnesses can only refuse, and one of them fails the repository outright.** The recorded-switch check and the unlisted-memory count exist because the on-disk marker can vanish with an ordinary deep clean; neither can ever *grant* reconciliation. The unlisted-memory count is intentionally unguarded, so an unreadable listing aborts the repository's pass rather than being read as "the source lists nothing". (Surprising; fail-closed by construction.)
- **The bootstrap flag is set to `done` even after a partial pass.** From then on every cursor gate applies. It is not a correctness hole only because the cursors of the failed tiers were withheld, so those tiers re-collect anyway — the flag and the cursors are two independent guards and only their combination holds. (Notable.)
- **The repository row is always projected as enabled at entry.** This pass has no branch that honours a disabled marker; the callers filter the registry before handing entries over, and a separate registry projection is what records a disablement. (Notable.)
- **The session tier re-projects everything on every pass, by design.** Sessions update out of order, so no high-water mark is sound. The consequence is user-visible: a converged run still emits real per-item session progress, which is why a caller cannot use "any progress at all" to decide whether there was work to narrate. (Notable.)
- **Absent and empty are different claims throughout.** An unreadable branch scan, a capped branch list, or a failed per-file scan all emit *nothing* for that field so the stored value survives; an empty value would be the positive claim "no branch reaches this" or "this commit touches nothing" and would delete correct rows on every pass. (Notable; the same rule appears in the cross-checkout merge, where an absent side poisons the union.)
- **The read source is pinned to a resolved tip for the whole pass.** Following the ref name instead lets a concurrent memory write make one pass see two versions — and a reconciling pass would then prune rows for paths that merely do not exist at the older tip it listed. (Notable.)
- **Only the two cursor-gated tiers can honestly say there was work.** The commits tier moves only when a checkout fingerprint changed and the memories tier only when the ref tip did; the session tier moves every time. Any caller deciding whether to announce work has to distinguish them by tier, not by progress volume. (Notable.)

## Shared Behavior

- The registry entries, the identity, and the recorded checkout list — including the deliberate non-empty fallback that makes the "any checkout alive?" test necessary in the first place — are defined by the **Dashboard Repo Registry and Probe** topic (cross-ref 355).
- The freeze marker, its per-clone scope, and the recorded switch this pass consults as a second witness are defined by the **Orphan Branch Cutover Fence and Compare-and-Swap** topic (cross-ref 345).
- The memory import's row families, its reconciliation, and its protection guard are owned by the memory source-of-truth topics; its lifecycle record and resume cursor by the **Orphan Import Lifecycle and Resume Cursor** topic (cross-ref 351).
- The projection layer, the write-ahead log, and the event schema are owned by the store-and-schema topics.
- The per-day rollup cache — what a cached day holds, which write stamps mark one stale, the settled sentinel, and the settle itself — is owned by its own neighbouring topic. This spec states only that every batch opts out of the settle, that one settle runs at the end of a repository's pass, and that a prune must name the days it destroyed.
- The unrelated model-spending back-fill of historical commits is defined by the **CLI Back-fill Command** (cross-ref 214) and **Back-fill Engine Orchestration** (cross-ref 227) topics; nothing in this spec applies to it.
