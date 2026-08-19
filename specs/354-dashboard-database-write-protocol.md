# 354. Dashboard Database Write Protocol

## Topic Statement

The one way anything writes the dashboard database: a durable event log committed in its **own** transaction, then a projection of those rows into the typed tables, then a settle of the per-day cache those projections just invalidated — plus the fire-and-forget producer wrappers that reach it from git hooks, an editor host and a recall answer without ever being able to fail their caller.

## Scope

**In scope:**

- What "the HTTP service does not write" does and does not guarantee, and the three places it writes anyway.
- The event envelope, the deterministic projection identity, and the log key that is deliberately **not** unique — and what that means for a replay.
- The phase order — log, then drain, then cache settle — why merging the first two reintroduces the bug they exist to prevent, what a crash between them leaves behind, and why the settle can only come last.
- The drain: what it revives, what it claims, what it excludes from the claim, the per-row transaction, the attempt cap, and the poison-pill parking with its two reasons.
- Why lock contention is not a failed attempt, and the whole-unit retry with its per-producer wait budget.
- What each event type projects, including the replace-when-observed contract and the carry-forward that stops an unobserved field from being clobbered.
- The wall-clock write stamp the activity projections set: unconditional, never coalesced, threaded in rather than read, non-uniformly named, and invisible when forgotten.
- The one conflict branch that adds to a stored value, and the delete beside it that is the whole reason it is safe.
- The placeholder repository row, and why an unregistered repository never fails a projection.
- Retention: what is pruned, what is never pruned, why age alone is not a reason, and why the per-day cache has no retention pass at all.
- The stored-aggregate rule: the bar it sets, and the one aggregate that has since landed and clears it.
- The producer wrappers: their three rules, the guards, the memoised identity with its self-registration, the tick watermark, and the memory-row refresh that rides alongside a commit write.
- Verification that a wrapper cannot fail its caller.

**Boundaries (consumed here, owned elsewhere):**

- The database file, its schema, its migrations, the connection pragmas, and the runtime floor that decides whether it can be opened at all. Only the columns a projection writes are stated here.
- The import/backfill sweep, which drives the *same* apply with its own batching, cursors and progress reporting.
- The read model built over these tables (spec 353) and the HTTP service that serves it (spec 352).
- The per-day rollup cache itself — its axis set, its day boundaries, its staleness query and the read side's fallback to computing a day live. Only the settle that rides a write, and the stamps that staleness query reads, are stated here.
- The outbound sync channel that pages the four session tables by their write stamps. Only the obligation to set those stamps is stated here.
- The repository registry file, its identity derivation and its lock (spec 355) — this spec covers only when a producer touches it.
- The cutover routing that decides whether a repository's memories are written here as the system of record or as a cache of the git-side store.
- How each event's *content* is collected from git, transcripts and stored summaries.
- The summary-tree assembly and memory-table upsert used by the memory refresh.

## Data Contracts

### Where writes come from

**No *capture* write depends on the HTTP service.** The database is a file and is always writable, so "the dashboard server was down and we lost data" is not a failure mode that exists — every fact about a commit, a session, a recall or a worktree is written by a producer that runs whether or not anything is serving. That is the guarantee; "the service never writes" is not, and stating it that way is wrong in three ways (below).

Every producer goes through one apply function: the post-commit queue worker, the agent stop hook, the editor host's periodic tick, the recall-answering surfaces (both the tool and the command line), and the import/backfill sweep. They differ only in which window of data they feed in — reader, projection and retention are shared, so a fact imported by a sweep and the same fact written live by a hook land on the identical row.

Each event is stamped with the kind of producer that wrote it, and that kind is what picks the writer's lock-wait budget. **Six kinds are declared; five are ever emitted** — the sixth, named for recovery, has no producer at HEAD, and the sweep that would plausibly use it stamps itself as the bootstrap kind instead. Its lock budget is configured all the same. (Unreachable.)

Three qualifications to "the service does not write", all real:

- **The registry projection is an event write, not a table poke.** When an enable, pause or resume lands, the service turns that registry entry into a repository event and puts it through this very protocol — log row, drain, projection — under the bootstrap producer kind. It is the shortest possible batch, not a different mechanism.
- **The service opens the database writable to bring the schema into existence or up to date**, and it does this while building the model for *any* request. So the frequently-repeated rule that this process never migrates is false as an absolute: what is true is that it can only migrate a file **behind** its own build (a file ahead of it is left alone), and that the registry projection above additionally refuses to run unless the versions match exactly.
- **One mutation route writes memory rows.** The browser-reachable summary backfill stores summaries through the ordinary storage layer, which on a cut-over repository is this database.

### The event envelope

Each event carries a payload plus provenance: which producer kind wrote it (one of the command line, the queue worker, the stop hook, the editor host, the bootstrap sweep, or the never-emitted recovery kind above), an optional producer version, and an optional "when it occurred" instant. The log row stores all of that alongside a **schema version** stamped on every event — currently **1** — a received-at instant, the serialized payload, a projection status, a claimed-at instant, an attempt count, and a failure reason.

The row's own primary key is an autoincrementing sequence. **The event's identity column is not unique, and is not even indexed** — the only index on the log is the one the drain uses (status + sequence). Every other index that once existed there covered columns no query filters on and cost a write per enqueue on the blocking commit path.

### The projection identity, and what "non-unique" means for replay

Each event type derives a **deterministic** identity from its own content:

| Event | Identity |
| --- | --- |
| Session observed | repository + source + session id |
| Commit created | repository + hash |
| Commit summary | a **different** namespace over the same repository + hash |
| Worktree status | repository + branch (empty string for a detached head) |
| Recall observed | repository + surface + the instant of the call |
| Repository enabled / disabled | repository |

Determinism is the whole idempotency story: a bootstrap sweep, a recovery pass and a live hook can all emit the same logical fact, and they must **collide on one row** rather than accumulate duplicates. The repository is part of every key because neither a session id nor a commit hash is unique across repositories.

The consequence of the log key not being unique is deliberate and load-bearing: **re-emitting the same logical fact appends a new log row** (a fresh sequence number, its own provenance and received-at) while its projection converges on exactly the row the first one wrote. So the log keeps every producer's trail — including both a commit's creation and its later enrichment, which is why those two use different namespaces even though they update the same commit row — and a replay of the log is safe because every projection is an idempotent upsert.

Two consequences worth stating:

- **Two recall calls in the same millisecond collide into one row.** Accepted deliberately: the instant is the only thing that distinguishes two otherwise-identical calls, and the alternative (a random id) would make a re-drained event duplicate instead.
- **A commit's enrichment can arrive before its creation.** Independent producers guarantee no ordering, so the enrichment projection creates the commit row itself.

### Stored aggregates: the bar, and the one that clears it

Projection is an idempotent upsert that coexists with out-of-order updates, pruning and replay, so a stored `total += value` would double-count on any replay and never converge after a delete. Re-deriving each touched aggregate in the same transaction was correct but bought nothing, because every reader aggregates at read time off the detail rows. Over the detail tables the invariant is therefore **structural rather than maintained**: those rows are the only totals, so they cannot disagree with a copy of themselves.

**The invariant is not "nothing is accumulated", though — one conflict branch genuinely adds to the stored value.** The per-model split's upsert sums its token and cost columns on conflict. What makes that safe is not the arithmetic but the wholesale delete of that session's split rows which runs immediately before it, inside the same conditional block and the same transaction: the addition can therefore only ever sum segments of one model listed twice *within one event*, never across replays. State it that way round — **the guard is the delete, not the absence of an addition** — because reading the invariant as "no projection adds" makes that branch look like a bug and invites someone to "fix" it into a plain overwrite, which loses the second segment.

**One stored aggregate has since landed**: a per-local-day cache of the spend axes and the token split, written on the write path (see the settle phase below). It does not repeal the bar — a measured read that is genuinely too slow — it clears it, in three ways:

- **Re-derived, never incremented.** A whole day is deleted and recomputed inside one transaction, so a day is never half updated. Two of the axes apportion a commit's spend against a window count that itself changes, so an incremental adjustment would have to difference against a moving divisor, and an arithmetic slip there accumulates forever with nothing to detect it. A rebuild is self-correcting: whatever was wrong yesterday is right today.
- **Never authoritative.** Every read of it may answer "not available", and the caller can then compute the day itself. Deleting every row changes only how long a page takes — which is what makes the settle skippable at all.
- **It has an expiry protocol, and staleness is asked rather than recorded.** Each cached day carries the instant it was built, and every table an axis reads carries the instant its rows were last written; a day is stale when a source row belonging to it was written after that. The alternative — writers recording "this day changed" as they go — fails the way a ledger fails: one write path that forgets to record leaves a permanently wrong number that nothing detects. A new write path is visible the moment it lands, because the rows it writes carry stamps.

That third property is the one the original bar did not cover, and it is what the write stamps below exist for. It has exactly one blind spot: a row that is *deleted* leaves no stamp behind, which is why the few paths that delete have to name the days they invalidated.

## Behaviors (execution order)

### Apply: log, drain, settle

**Phase 1 — the write-ahead log.** Every event in the batch is inserted with status `pending`, all sharing one received-at instant. It **commits on its own**. Skipped entirely for an empty batch.

**Phase 2 — the drain: claim and project.** Always runs, **including for an empty batch**: that is how any writer picks up rows a crashed predecessor committed but never projected. The batch just inserted is itself pending, so this is also what projects it.

The drain is *not* a second transaction, despite the protocol usually being described as two: it is **one transaction per row** plus several statements that deliberately run outside any transaction (the revival, the claim query, the attempt bookkeeping, the pending count). What matters — and what the shorthand is shorthand *for* — is that the log insert commits **before** any projection begins. Merging those two reintroduces exactly the bug the split exists to prevent: only because the log has committed does a crash between them leave anything to recover. In a single transaction the crash would roll the pending rows back together with the half-done projection, and the events would be gone.

**Phase 3 — settle the per-day cache.** The days the projections just invalidated are recomputed, and this runs **after** the drain, never before: the rows this call wrote are exactly what makes a cached day stale, so building first would cache the state the call is about to leave. Three properties make it safe to hang off a write path:

- **Bounded** — at most **fourteen** days per call. It runs inside the writer's lock, on a path an editor's periodic scan reaches, and that caller waits milliseconds for the lock; falling behind costs a slower page, while holding the lock costs somebody else's write. A backlog therefore drains across calls, because there is always another call.
- **Quiet** — a failure is logged at information level and never propagated. The write it rides has already succeeded, so the only cost of skipping is a slower page; the likeliest failure is a standing, structural one rather than a transient, which is why it is recorded rather than shown.
- **Opt-out-able** — an apply option skips it for this call. A caller that makes many apply calls in a row sets it on every one and settles once itself, because each batch's writes mark the days it just touched stale, so leaving it on rebuilds the same newest days once per batch and keeps only the last: quadratic work for a result nobody reads. The repository backfill sets the option on **every** batch and settles once at the end of a repository's pass. Skipping is always safe, because the cache is derived and a day nobody settles is simply computed live — the risk of that option is a slower page, never a wrong number.

The apply reports three numbers: rows accepted into the log, rows projected in this call (including drained leftovers from a predecessor), and rows left pending. The settle contributes nothing to them.

### The drain

1. **Revive.** Rows parked as `failed` **for the reason `unknown-type`** whose type this build now understands are reset to `pending` with a zeroed attempt count and a cleared reason. It runs before the claim, outside any transaction, and is machine-global rather than scoped to the calling batch's repositories. A row reaches that reason only when an older build met a newer producer's event, and the promise made there is that the event survives for a build that understands it — a promise that was empty until this step existed, because the claim below selects only `pending` and nothing reset `failed`. Scoped to types this build knows **and** to that one reason, so a genuinely defective event stays parked rather than burning its budget again on every drain.
2. **Claim** up to **500** rows in sequence order with status `pending`, an attempt count below **5**, and a schema version at or below this build's. The batch bound keeps write locks short.
   - **Future-schema rows are excluded from the claim, not merely skipped in the loop.** Skipping alone makes them head-of-line blockers: the claim is ordered by sequence with a limit, so once a batch's worth of them accumulates at the head (a newer editor build writing beside an older command-line build — supported version skew) the old build can never reach its own newer pending rows and stalls silently. They stay pending and are still counted, so nothing is lost or guessed at.
3. **Project each row in its own transaction**, which stamps the claim and increments attempts, runs the projection, and marks the row `projected`. Per-row rather than one batch transaction: a few more commits, but a single malformed event cannot roll back the hundreds of good rows beside it — which is precisely the scenario the log exists to survive.
4. **On failure**, the reason decides everything:
   - **Lock contention is not a defective event and must not spend the attempt budget.** The transaction already rolled the claim back, so the row is left untouched — still pending, with its original count — and the next drain simply tries again. Five lost races used to park a perfectly good event at `failed` forever, and nothing in the product ever resets that status, so its sessions, commits and usage samples were gone from every figure until the database was rebuilt.
   - **Any other failure** bumps the attempt count **outside** a transaction (the in-transaction bump was rolled back with everything else; without this a permanently-failing row is retried forever and starves the queue). At the cap the row becomes `failed` with a recorded reason — `unknown-type` only when the projection dispatch found no handler, `error` otherwise — and is logged loudly. Below the cap it stays `pending` and is logged as a retry.
5. **Count what remains** from the table, never accumulated, under **exactly the same predicates as the claim**. The count means "events still unprojected", because it is what the import sweep consults before advancing its cursor: a predicate mismatch turns a row this runtime can never claim into a permanent cursor stall rather than a delay. It is scoped to the repositories the calling batch speaks for, since the log is machine-global and another repository's in-flight rows would otherwise hold back this one's cursor (that kind of delay is self-healing, which is why it is scoped rather than counted as an error). An empty scope falls back to the global count.

### Retry and wait budgets

An apply that opens its own handle retries **the whole unit of work** — not the transaction — up to **3** attempts when the failure classifies as a lock, with a jittered exponential backoff starting at **120 ms** (jittered so several surfaces that lost the same race do not wake together and collide again). Retrying the whole unit is safe because every projection is an idempotent upsert: a redo converges on the same rows rather than duplicating them. It is done at this level because here the code can await, whereas a retry inside the synchronous transaction could only spin.

How long a writer waits for the write lock is a property of **who is writing**, not of the database: detached background writers (the post-commit worker, bootstrap, recovery) wait generously because nothing is waiting on them and dropping the write means relying on a later recovery pass; the editor host waits briefly and lets its next tick try again, because waiting there is visible as a frozen UI and the data is re-derivable.

### The dispatch and its two guarantees

Dispatch is exhaustive over the event types, backed by two mechanisms that are both needed:

- A **compile-time** exhaustiveness assertion, so adding an event type without a projection fails the build. The silent fall-through it replaced marked such an event `projected`, after which retention deleted it — precisely the version-skew loss the log exists to prevent, and one that a schema version cannot catch (it gates payload *changes*, not a new type).
- A **runtime throw** for the case the compiler cannot see: an older build draining a newer producer's event. Throwing routes the row through the attempt counter to `failed`, which is retained forever, logged loudly, and revivable by a later build.

A second compile-time assertion keeps the **revival allowlist** in step with the same union. Only the dispatch was guarded before, and the asymmetry was silent by construction: a type missing from the allowlist is an error nowhere, it just means a transient failure of that one kind becomes permanent and nothing says so.

### What each projection writes

**The activity projections stamp a wall clock on every row they write**, and doing so is a genuine obligation of the protocol rather than bookkeeping nobody depends on. The session row, the commit row, the session's three child sets and the recall receipt each carry a "when did we last write this row" value, and four rules govern it:

- **Bumped unconditionally on every write, including the conflict branch** — a conflict is still a write, and a reader keyed on the stamp would otherwise never see a summed segment or a recount.
- **Taken from a clock threaded into each projection as a parameter**, not read inside one. That makes it pinnable and, more importantly, makes it visibly *not* one of the event's own business timestamps: writing an instant the event carried would quietly turn the column into a second business clock and defeat its only purpose.
- **Never coalesced with the stored value.** The per-day cache's expiry test compares against it, so preserving an older value hides the change the projection just made.
- **Non-uniformly named, deliberately.** The session and commit tables spell it one way and the three child sets another, because on the session table the obvious name is already taken by the business clock ("when was this session last active"). A query written to one name compiles, runs, and reads the wrong column on the session table.

The motivating case is the commit-summary projection's session seed below: it deliberately does **not** bump that business clock, since a commit's clock is not the session's, so the write stamp is the only thing that makes the improved token split it just wrote visible at all. A projection that forgot the stamp fails nothing visibly — it silently takes its rows out of the outbound upload channel for ever, and a row whose stamp is null or stale is invisible to every cursor permanently.

**Repository enabled** upserts the repository row and **clears any disable stamp**. **Repository disabled** stamps it; rows and data are kept, never deleted. Disable is the one projection that does **not** first ensure a row exists, so disabling an identity this database has never seen updates nothing and reports nothing — harmless only because there is no data to hide.

**Every other projection first ensures a repository row exists.** Foreign keys are on, so a session or commit for an unregistered repository would fail the whole projection — and that happens legitimately, because a hook can write before an enable has been projected and event order across independent producers is not guaranteed. The placeholder carries the identity as its name, an empty checkout path and an epoch timestamp; a later registry projection fills in the real values. Resolving an identity to its key is deliberately **not** cached, since a process-wide cache keyed on identity alone would hand one database's key to another.

**Session observed** upserts one session row plus its three child sets — the per-model split, the tool-call rows, and one row per counted model response. The rules that govern it:

- **Token totals come from the per-model split when it is present**, so the scalar columns can never disagree with the split. Only a source with no per-model breakdown falls back to the event's own scalars.
- **An event carrying no usage information at all means "unobserved this time", not "zero".** Writing zeros would clobber a previously enriched row, so the stored values are carried forward. A display model is recorded alongside — whichever burned the most tokens — purely so a row can be labelled without a join.
- **Child rows are replaced wholesale when observed, and left alone when not.** The model split is deleted and rewritten only when the event both carried usage **and** declared a split. Testing the second half alone let one shape fall between the two rules — an empty split with no scalar tokens is "unobserved" to the carry-forward (which keeps the stored tokens) and "provided" to a split-only test (which empties the split), leaving a session whose totals report tokens while the model axis reports none. **The two conditions are deliberately not the same predicate**, and the code's own comment beside them claims they are: the carry-forward asks only "was usage observed", while the delete additionally requires the split to have been declared, which is what closes the gap. Tool rows are gated on a **third**, independent condition — whether tool records were declared at all, with no usage requirement — so a source whose transcripts carry no tool records sends nothing and cannot erase what a fuller read collected.
- **The per-response set is the third child set, with a gate of its own**: one row per counted model response, keyed by the session and a per-response deduplication key, replaced wholesale whenever per-response usage was declared at all — with **no** usage requirement, unlike the model split, which needs both. That is the *same* one-condition shape the model split's bug was, and here it is correct: an empty set alongside no scalar tokens leaves the carried-forward session totals in place, which routes the session to the session-level fallback when the series is read — a loss of per-day resolution, never a loss of the total. Nothing can end up reporting tokens on one axis and none on another, because the axis the set feeds falls back to the session's own figure.
- **That set is also the only place a projection touches the per-day cache.** It reads the previously stored responses' instants and forgets those cached days **before** emptying the set, because a removed response leaves no write stamp behind for the staleness scan to find; the replacement rows only expire the days that still have responses. Over-forgetting there costs one recomputation and never a wrong number. Its inserts are then **plain inserts with no conflict clause**: the delete just emptied this session's rows and the key cannot repeat, so a conflict would mean one of those two invariants broke, and throwing says so instead of quietly merging. A source that cannot name a response is keyed by its line position among the counted responses, which is unique within the batch — all the key has to be once the set is replaced wholesale.
- A tool row's **last-call instant takes the maximum** of the incoming and stored values, not the incoming one: a re-read by a parser that cannot stamp a time would otherwise erase an instant a better read already recorded, and that column cannot be recovered (the transcript slice is behind a cursor by then). Both-absent is preserved as absent rather than collapsing to zero, because a stored zero reads back as a real epoch-0 instant and defeats the reader's fallback to the session's own clock.

**Commit created** upserts the commit row, preferring the stored value for any field the event did not carry — **except two columns that are overwritten unconditionally**: the committed instant, since the event type always carries one and the newest read of it is the one to believe, and the write stamp, for the different reason given above (the cache's expiry test compares against it, so a coalesce there would hide the change) — and then applies the same replace-when-present rule to two child sets: the branches the commit is reachable from (replacing the set is what *prunes* a branch it no longer reaches, and an empty array is meaningful), and its per-file line counts (an amended commit can drop a file, and only replacing removes it). Branch names are interned per repository rather than repeated per row.

**Commit summary** upserts the commit row (creating it if the summary arrived first) and otherwise owns exactly one thing: **seeding sessions the memory pipeline is the only remaining record of** — sessions older than the agents' own retention. The enrichment columns and child tables it used to write are gone; the read model reads memory data from the memory tables, which the same worker pass refreshes, and writing copies here would recreate the falls-behind-on-regeneration problem that move solved. The seed is guarded so a live-discovered full row stays authoritative: it only inserts, or upgrades a row that was seeded without token coverage. The per-model split and the tool rows are written **only** when that insert or upgrade actually happened, which is what keeps the live transcript read — the more complete record — the winner.

  - **A known, deliberate understatement:** a memory owns only the slices of a session its own commit consumed, while the session tables carry no commit dimension. So a session split across several commits contributes whichever slice seeds the row, and later commits add nothing. Summing instead would inflate on every replay, and telling "another commit's slice" apart from "this commit again" needs a column that does not exist. Undercounting a split session beats a number that grows every time the queue redrains.

**Worktree status** does its own housekeeping first — deleting this repository's observations older than **24 hours**, measured against the *observation's own* clock so the projection stays a pure function of the event and a replay converges — then upserts the row for this repository and branch, latest-wins. The age gate exists on both ends (readers ignore stale rows, writers drop them) because nothing polls for this: observations ride commits and the editor's tick, so a repository whose editor is closed and which is not being committed to simply stops reporting, and the row would otherwise claim uncommitted changes forever.

**Recall observed** upserts one receipt keyed on the event's own identity, so a re-drained event converges on the row it already wrote instead of appending a second call — the same idempotency as every other projection, expressed as an upsert because there is no natural business key for "a call" beyond when it happened. It sets a write stamp on its conflict branch like the others, and **nothing reads it**: this table has left the outbound upload channel and carries no entry in that channel's stamp mapping, so the column and the two indexes behind the channel's paging are written on every receipt and read by nothing. They stay in the schema because they have already been migrated.

### Retention

After an apply that opened its own handle — and, separately, at the end of a per-repository import sweep, on the handle that sweep already holds — up to **2,000** `projected` rows older than **14 days** are deleted. `pending` and `failed` rows are **never** pruned regardless of age: pending rows are the crash-recovery record a later writer drains, and failed rows are the poison-pill evidence for something that needs looking at. **Age is not a reason to discard either — only successful projection is.** The pass is bounded so a first prune against a log that has grown for months cannot hold the write lock, runs on a path that already holds it, and **swallows its own errors**: housekeeping must never fail a write that already succeeded.

**The per-day cache has no retention pass at all**, and needs none: it is bounded by the build horizon instead — a day older than that is never cached and simply computes live — so it cannot grow with the machine's history the way the log can. Rows leave it exactly three ways: a whole-day rebuild deletes and replaces them, an explicit forget drops the days a delete invalidated, or a repository is forgotten and its cached rows go with it. Age is not one of them.

### The producer wrappers

Thin wrappers the hot-path producers call. Three rules, because these run inside git hooks and an editor:

1. **Never throw.** A dashboard write failure is a log line, not a broken commit or a dead agent hook. The data still lives in the git and summary sources of truth, and the next recovery import picks it up.
2. **Degrade below the runtime floor.** On a runtime whose embedded SQLite cannot be loaded without a flag, skip the write silently.
3. **Stay off the blocking path.** They are called from an already-detached worker, an asynchronous stop hook, a timer tick, and after a recall answer has been produced — never from anything a user is waiting on.

**The shared guard-and-apply** checks the runtime floor, then resolves the repository identity, builds the events, and applies them — with **everything after the floor check inside one catch** that logs and answers "did not write". An empty event list is a no-op. The floor check itself is a version-string parse over a process-provided value and cannot throw, so **this function cannot fail its caller**, which is what lets the recall receipt be fired at four call sites without being awaited or caught at any of them.

Two wrappers place a statement or two *ahead* of that boundary — reading the call's own instant off the outcome it was handed, and materialising a hash collection — so the guarantee is strictly a property of the shared function, not a property proved at each entry point. Every such statement is total for the arguments the shipped call sites pass, but the entry points are where a future one would land outside the net. The editor host does not rely on the guarantee: it attaches its own rejection handler anyway.

**Identity resolution is memoised per working directory for the process lifetime**, and on the first resolution it also makes sure the repository is in the machine-level registry — which is what makes repositories enabled before the registry existed visible without any user action: work in a repository and it appears. Two rules keep that safe:

- It only fills a **genuinely missing** entry. An unconditional registration would clear a disable stamp, which is right for an explicit enable and would let a stray hook silently undo a deliberate pause. A known identity whose checkout list lacks *this* checkout goes through a union-only extension instead, which cannot touch the disable stamp.
- **The memo is set only after registration settles.** Caching the identity first short-circuits every later call in the process, so a registry write that failed was never retried — permanently, in a long-lived editor host. Identity resolution is the cheap half; the registration is the part worth another attempt. A registry failure is logged at debug and the write proceeds anyway, because the placeholder repository row means data is never lost for want of a registry entry.

**The registry directory is derived from the database path** rather than taken as a second parameter, because in production the two are siblings — so a caller that redirects the database into a temporary directory redirects all of this state with it. Without that, a test exercising these producers wrote a junk entry into the developer's real machine-level registry.

Per producer:

| Producer | What it writes |
| --- | --- |
| Agent stop hook | One session-observed event for the session that just ended. |
| Post-commit worker | One commit-created event per hash in the drain (subject, author name **and** email, the current branch as both the branch and the whole reachability set, and a per-batch file breakdown), plus a commit-summary event for each hash whose summary can be read, plus one fresh worktree observation. Then, separately, a memory-row refresh. |
| Recall surfaces | One recall-observed event, with the session id **only** when the host advertised one in the environment. |
| Editor tick | Session-observed events for the sessions whose update time moved past a watermark, plus one worktree observation — **only if at least one session event survived that filter**. An idle tick writes nothing at all, so the worktree row is refreshed by activity rather than by the clock. |
| Editor / bridge memory edit | A memory-row refresh only — no events. |

**A session-observed event may now carry per-response usage**: one entry per counted model response, each with its own instant, alongside the whole-session per-model split that is the same numbers with the time thrown away. It is forwarded whenever the reader reports the source is usage-capable — **including as an empty array**, so a re-read that can see usage but nothing datable clears rows an earlier, better read left behind, while *absence* means the source records none at all and must leave stored rows alone. Lines the parser cannot date, and lines reporting zero tokens, are dropped from that set while still counting in the session's own totals — a wrong day is worse than a missing one here, and a line reporting no usage at all is not a response.

Three details on the worker path: the file breakdown is collected in **one** pass for the whole batch, and a **partial** result from it is the normal shape rather than an all-or-nothing outcome (without any of this, the very commits a user just made would be the ones missing from any per-file view); a hash that vanished mid-drain because a rebase raced it is logged at debug and skipped rather than dropping the batch; and the current branch is recorded as the entire reachability set, which for a just-created commit *is* its reachability, with the next recovery pass replacing it with the full union.

On the first of those: one commit whose diff overruns the collector's subprocess output buffer fails the whole call, and it fails identically on every retry, so a failed pass is **halved and re-asked breadth-first** under a budget of up to **twenty-four** extra calls. Every commit the salvage resolves gets its file rows; the rest get no `files` field at all — which the projection reads as "leave the stored value alone", never as "this commit touches nothing".

Both author identity fields are sent, not just the name: the standup filter matches on **either**, and a machine with no configured name would otherwise have every commit made since the last sweep silently dropped from the board while the board still claimed to be filtered to the user.

**The editor tick's watermark advances only after the write reports it landed.** Moving it while building the batch would make a swallowed failure permanent: those sessions are no longer "newer than the last write", so no later tick retries them and the rows stay missing until the session is touched again or a recovery import runs.

**The recall receipt is the odd one out.** Every other event restates something durable — a commit, a session file, a summary — and losing it costs a rescan. A recall call exists only while it is being answered, which is why it is observed at the answering edge rather than recovered from a transcript afterwards. Its session id is read from the environment and left **absent** when no host published one; the available fallback (pick the most recently touched session) is a guess that would look exactly like a fact once stored, and would be wrong in the one direction nobody can audit.

**The worktree observation** is a fresh read of the working tree on every write — the one piece of live state with no historical source, so it is always latest-wins. It deliberately asks git for the whole tree rather than going through a helper that takes an explicit path list, because that helper short-circuits to all-zero on an empty list and would silently report a clean tree. When git is unavailable it answers nothing: an unreadable worktree is not worth failing a write batch over, and the next observation overwrites the row anyway.

### The memory refresh

Riding alongside the post-commit write, and reachable on its own from the editor-side edges, is a re-projection of the memory rows for a set of commit hashes: each summary is read back through the active storage backend (with its linked transcripts, so the link replacement inside the memory upsert does not drop them as dangling) and upserted into the memory tables.

- It is gated on the same **user opt-out** the storage backend checks. Not redundant: this path calls the memory upsert directly, so that check never runs — and its editor-side callers invoke it unconditionally after a store that itself no-ops when disabled. What lands is the unchanged summary, so nothing is corrupted, but a repository the user turned off would still get its database created and its rows rewritten.
- It is called from the **host edges** rather than from the store itself, because it creates the database and the registry on first use — right for a user action, wrong for every unit test and hook path that happens to store a summary.
- Its purpose on the editor edge is that an in-place memory edit (detaching a conversation, removing a plan, deleting a topic, regenerating) rewrites the stored summary through a backend that on the default route touches no database at all. Nothing else notices, so before this existed an edited memory kept serving its pre-edit conversations and context until the next commit for that same hash — in practice, never.
- It is wrapped in its own catch and logs non-fatally. Its guards (the opt-out flag, the runtime floor, an empty hash list) are all total expressions, so like the shared wrapper it cannot fail its caller.
- A missing repository row means the stats write itself failed; the refresh returns quietly rather than creating one.

## State Transitions

### One log row

| From | Event | To |
| --- | --- | --- |
| — | Accepted into a batch | `pending`, attempts 0 |
| `pending` | Claimed and projected | `projected` |
| `pending` | Projection hit lock contention | `pending`, attempts **unchanged** (transaction rolled back) |
| `pending` | Projection failed, attempts below the cap | `pending`, attempts + 1 |
| `pending` | Projection failed, attempts reaching **5** | `failed`, with reason `error` |
| `pending` | Dispatch found no handler for the type, at the cap | `failed`, with reason `unknown-type` |
| `pending` | Schema version ahead of this build | **Never claimed** — stays `pending`, attempts stay 0, still counted |
| `failed` (`unknown-type`) | A drain by a build that knows the type | `pending`, attempts reset to 0 |
| `failed` (`error`) | Any drain | **Unchanged** — parked permanently |
| `projected` | Older than **14 days**, retention pass | Deleted |
| `pending` or `failed` | Any age | **Never** deleted |

### One producer call

| From | Event | To |
| --- | --- | --- |
| Any | Runtime below the SQLite floor | Skipped silently, reports "did not write" |
| Any | Identity resolution or event build throws | Logged, reports "did not write" — **caller unaffected** |
| Any | Empty event list | No write, reports "did not write" |
| Identity unresolved | Registry write succeeds | Identity memoised for the process |
| Identity unresolved | Registry write fails | Identity **not** memoised — the next call retries |
| Tick watermark at T | Write lands | Watermark advances to the newest session written |
| Tick watermark at T | Write dropped | Watermark **stays at T** — the same sessions are retried next tick |

## Notable / Surprising Behavior

- **The log-then-drain split is the entire crash-recovery mechanism.** Nothing else recovers a half-done projection: the recovery is simply that the next writer's drain finds pending rows, whoever that writer is. (Notable; merging them is the one change that must never be made.)
- **The drain always runs, even for an empty batch** — that is how a writer with nothing of its own to say picks up a crashed predecessor's leftovers. (Notable.)
- **Lock contention deliberately does not count as an attempt**, and the row is left untouched rather than re-marked. A database that stays locked means nothing is progressing anyway, so there is no queue to starve. (Notable; the opposite behaviour lost data permanently.)
- **A future-schema row is excluded from the claim rather than skipped inside it**, because a skip makes it a head-of-line blocker under an ordered, limited claim. (Surprising; the obvious implementation is the broken one.)
- **The "unknown type" parking promised recoverability that did not exist until a revival step was added.** The claim selects only pending rows and nothing reset a failed one, so an upgrade never recovered the event the comment said would survive. (Notable.)
- **Two compile-time assertions guard two different lists**, and only one of them existed at first. A type missing from the revival allowlist is an error nowhere and silently turns a transient failure into a permanent one for that kind of event. (Surprising.)
- **The pending count must use exactly the claim's predicates.** It gates an import cursor, so a mismatch is a permanent stall for every repository rather than a delay — and the count it replaced reported a clean drain over hundreds of rows the batch limit had not reached. (Notable.)
- **A single one-character difference in a guard was a real bug.** Deciding "were child rows provided" from the presence of the array alone, while the carry-forward decides "was usage observed" from a wider condition, let an empty split with no scalar tokens keep the stored totals *and* empty the split — a session whose headline reports tokens while the model axis reports none. The fix was to make the delete require **both** conditions, not to make the two the same; the comment sitting beside it still says they are identical, and they are not. (Surprising; the comment is stale and the stricter code is the correct one.)
- **The per-response set is gated on one condition, which is the shape the bullet above calls a bug — and here it is correct.** Declared-at-all is enough because an empty set beside no scalar tokens leaves the carried-forward session totals standing, and the axis that set feeds falls back to the session's own figure: per-day resolution is lost, the total is not. The same shape on the model split lost a whole axis instead. (Surprising; the two gates look interchangeable and are not.)
- **A delete is the one thing the per-day cache cannot notice, so the one projection that deletes has to announce it.** The per-response set forgets the previously stored responses' cached days *before* emptying itself, since a removed row leaves no write stamp behind. Over-forgetting there costs one recomputation; under-forgetting serves a stale day for ever. (Notable.)
- **"The two transactions" is neither two nor transactions.** The apply is three phases: only the log insert is a single committed unit, the drain runs a transaction per row around several uncommitted statements, and a third phase settles the per-day cache after them. The familiar name describes the ordering guarantee between the first two, not the shape of any of them. (Surprising.)
- **The cache settle runs after the drain, and a bulk caller turns it off entirely.** Before the drain it would cache the state the call is about to leave; left on for every batch of a backfill it rebuilds the same newest days once per batch and keeps only the last. Skipping is always safe because the cache is derived — the cost is a slower page, never a wrong number. (Notable; the ordering looks arbitrary and is not.)
- **A both-absent timestamp is preserved as absent, never collapsed to zero**, in both places that write a tool row: a stored zero reads back as a real instant and defeats the reader's fallback. (Notable.)
- **The write stamp is bookkeeping that is nonetheless load-bearing, and forgetting it is silent.** It is bumped on every write including the conflict branch, threaded in as a clock rather than read inside a projection, and never coalesced — and its names are deliberately non-uniform, because on the session table the obvious name is already the business clock. The case that forced it: the commit-summary seed improves a session's token split without touching that business clock, so the stamp is the only evidence the improvement happened. A projection missing it takes its rows out of the outbound upload channel permanently, with nothing failing. (Notable.)
- **The recall receipt's write stamp is written on every receipt and read by nothing.** That table left the upload channel and has no entry in the channel's stamp mapping, but the column and the two indexes behind the channel's paging remain, because they have already been migrated. (Notable; a stamp with no reader, not a missing one.)
- **An unregistered repository never fails a projection.** A placeholder row is created from the identity alone, with an empty checkout path that downstream readers must special-case. (Notable.)
- **A commit's enrichment writes almost nothing of its own any more.** It owns the commit row and the seeding of sessions older than the agents' retention; everything else it used to copy is read from the memory tables instead, so a regenerated memory cannot leave stale copies behind. (Notable.)
- **A session split across several commits is knowingly undercounted**, because the tables have no commit dimension and summing would inflate on every replay. (Surprising; deliberate.)
- **The worktree row prunes itself on the observation's own clock, not the wall clock**, so a replay of the same event converges instead of deleting a different set of rows each time. (Notable.)
- **Retention deletes on successful projection only.** A failed row is evidence and a pending row is recovery state; neither ages out. (Notable.)
- **"Nothing is accumulated" is not the invariant — one conflict branch really does add to the stored value.** The per-model split's upsert sums, and it is safe only *structurally*: a wholesale delete of that session's split rows runs immediately before it, in the same conditional block and the same transaction, so the addition can only sum segments of one model listed twice within one event. The guard is the delete. (Surprising; reading it as "no projection adds" invites turning that branch into an overwrite, which loses the second segment.)
- **A stored aggregate has landed, and it clears the bar rather than repealing it.** The per-day cache is re-derived and never incremented, is never authoritative (any read may answer "not available" and the caller computes the day itself), and carries an expiry protocol that *asks* the sources' write stamps instead of trusting writers to record what they changed. Deleting every row of it costs only page latency. (Notable; the old absolute — "there are none" — no longer holds.)
- **The shared guard-and-apply genuinely cannot fail its caller.** Everything after the runtime check runs inside a catch, and the runtime check itself is a pure parse of a process-provided version string — which is why every recall-receipt call site fires it without awaiting or catching. The per-producer entry points around it are where the net stops: two of them evaluate a statement before entering it. (Verified, with that boundary named.)
- **"The service never writes" is the one claim in this area that does not survive contact with the code.** It writes a repository event through this protocol on every enable/pause/resume, and it opens the file writable to create or upgrade the schema while serving a page. What is actually guaranteed is narrower and more useful: no *capture* depends on it running. (Surprising; the module's own header states the stronger, false version.)
- **The identity memo is set only after registration settles**, so a transient registry failure is retried rather than locked in for the life of a long-running host. (Surprising; the obvious ordering is the broken one.)
- **A hook never resurrects a repository the user disabled** — it fills a missing entry or unions a checkout, and nothing more. (Notable.)
- **The editor tick's watermark and its write are ordered so a swallowed failure is retried**, not silently skipped forever. (Notable.)
- **The recall receipt is the only event that cannot be reconstructed later**, which is why it is written at the answering edge, and why an absent session id is left absent rather than guessed. (Notable.)
- **The memory refresh re-checks the user opt-out that the storage layer would otherwise have checked**, because it bypasses that layer — otherwise a disabled repository still got a database created and its rows rewritten. (Surprising.)

## Shared Behavior

- The database file, schema, migrations, connection pragmas, per-role wait budgets and the runtime floor are owned by the dashboard store topic.
- The import/backfill sweep drives this same apply with its own batching and cursors, and consults the pending count returned here before advancing them.
- The read model over these tables is owned by spec 353; the HTTP service that serves it — including its schema-version gate on the registry projection, and the concurrency guard on its one model-spending mutation — by spec 352.
- The per-day rollup cache — its axis set, its day boundaries, its staleness query and the read side's fallback to a live day — is owned by its own topic. This spec owns only the settle that rides a write, and the write stamps that staleness query reads.
- The outbound sync channel that pages the four session tables by their write stamps, and the cursor it pages with, are owned by their own topic. This spec owns only the obligation to set the stamp.
- **A memory write path that deletes, re-grounds or re-aliases a memory row must name the cached days it invalidated.** None of those three moves a column carrying a write stamp — a delete leaves nothing behind at all, a re-grounding changes which generation a row belongs to (and the divisor an apportioned axis divides by), and an alias moves a memory between calendar days — so the staleness scan cannot notice any of them. Every other change the cache works out for itself, which is why this is a rule for those three and not a general one.
- The registry file, identity derivation, registration paths and their lock are owned by spec 355.
- Cutover routing decides whether this database is the system of record for a repository's memories or a losable projection cache of the git-side store.
- Event content collection from git, transcripts and stored summaries, and the memory-table upsert the refresh calls, are owned by their own topics.
