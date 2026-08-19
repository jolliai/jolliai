# 374. Daily Statistics Rollup Cache and the Local-Day Engine

## Topic Statement

The per-local-day pre-aggregate that sits in front of the activity view's spend axes and its token split: what a cached day contains, how a day becomes settled, how it expires — by asking the source tables rather than by being told — the deletes and moves that no stamp can report and must therefore be named by the writer, and the local-calendar engine both the read path and the cache builder derive their day boundaries from. The engine is shared for one reason: two independent derivations would disagree exactly on the daylight-saving days it exists to get right, and disagree silently.

## Scope

**In scope:**

- The cached row's key — repository, zone, local day, kind, series key — and why the zone is part of it.
- The `kind` namespace: one entry per series dimension, one for the token split, and the sentinel that separates "computed, nothing happened" from "never computed".
- The sentinel's reserved repository id, its once-per-day storage, and its position last inside the settling transaction.
- The two bounds on the work: the ninety-day build horizon and the fourteen-day-per-build budget, and which of the two is a correctness statement (neither).
- The rule that the cache is never authoritative, and its two consequences: every read may answer "not available", and the table is excluded from the outbound upload channel.
- The whole staleness protocol: what qualifies a day, what the comparand is, the two unions the source scan runs, why both of its bounds are load-bearing, and why the comparison is strictly greater-than.
- What staleness structurally cannot see — deletes, moves, re-groundings, aliasing, a repository rename — and the writer-side day-forget that closes the first four.
- How one window is split into settled days and days that must be computed live, and why the live set is filtered by membership rather than by its enclosing range.
- Settling one day: whole-day replacement, newest-first ordering, and the one transaction the delete and the inserts share.
- The write-side schema-version gate, and the deliberate absence of a read-side one.
- The local-day engine: the zone it resolves, the day key, the midnight inversion, the round-trip validation, the day step, and the guard that throws rather than hangs.
- The shared row readers both sides go through, the session-completeness test that decides which of their two arms counts a session, and the single landing expression that dates a memory.
- Constants with no production reader, and paths unreachable from any production caller.

**Boundaries (consumed here, owned elsewhere):**

- The database file, the schema this table is declared in, the migration ladder that created it, the permission modes, and the per-writer-role write-lock waits (347). Only the columns this cache reads and writes are stated here.
- The write protocol that produces the stamped source rows, and that calls the settle as a side effect of every apply (354). What that protocol owes this cache — naming the days it invalidated — is stated here; how it writes is not.
- The read model that consumes a plan and a settled day, its scope / window / dimension axes, the below-tier axis fallback, and every card built on top of the series (353).
- The historical import and per-repository backfill sweep, which drives the same settle once per pass and whose commit prune is one of the writers that forgets days.
- The cutover fence and the protected catch-up import whose stamping interacts with this cache; the freeze protocol itself, and the routing that decides whether a repository's memories are in this database at all.
- The outbound session-statistics sync channel, which lists this table as never synced.
- Repository removal, which must delete this table's rows by hand; the removal path is its own topic.
- What a session, a memory or a commit row *means*, and how each source table's write stamp comes to be set.

## Data Contracts

### The cached day

**`stats_daily`** — one row per repository per zone per local day per kind per series key.

| Column | Meaning |
| --- | --- |
| `repo_id` | A real repository id on every data row; `0` on the sentinel. |
| `tz` | The IANA zone the day was cut in — **part of the key**. |
| `day` | The local calendar day, `YYYY-MM-DD`. |
| `kind` | A series dimension, the token split, or the sentinel (below). |
| `series_key` | The series within the kind — a model / agent / project / branch / ticket / category name for an axis, `input` / `output` / `cached` for the token split, the empty string on the sentinel. |
| `value` | **`REAL`, not an integer.** Two of the axes apportion one commit's spend across its topics or its branches, so a day's contribution is genuinely fractional; the read path rounds at emission exactly as the live path does. |
| `cost_usd` | The estimated cost carried alongside, defaulting to zero. |
| `built_at_ms` | When the day was computed. This is the comparand every staleness test uses, so it must never hold a business time. |
| `updated_at_ms` | The row's write stamp. |

There is deliberately **no foreign key** to the repository table: the sentinel carries a repository id no registry row has, and nothing here should cascade — the table is rebuilt, not maintained, and its delete path is explicit. A secondary index on `(tz, day)` exists because both delete paths filter on that pair, which is not a prefix of the primary key.

**The zone is in the key rather than assumed.** A day boundary is a property of the asker, so a reader in another zone misses and builds its own rows rather than reading someone else's midnights as if they were its own.

**Rows are replaced a whole day at a time**, never adjusted incrementally. Two axes divide by a window count, so an incremental update would have to compute a difference against a divisor that itself moved, and an arithmetic slip there accumulates forever with nothing to detect it. A rebuild is self-correcting: whatever was wrong yesterday is right today.

### The kind namespace

The kinds are one per series dimension — `model`, `agent`, `project`, `branch`, `ticket`, `category` — plus `tokens` for the "where your tokens went" split, plus the `built` sentinel. The axis names come from the dimension type and the other two are invented here, so they share one namespace and must not collide: a dimension named `tokens` would have a day's token split read back as if it were an axis, silently.

**The axis set is derived from the dimension type, so adding a dimension is a compile error.** That is not tidiness. An axis absent from the set would never be built, while a plan — computed once for the whole page, knowing nothing about which axis is being drawn — still reports every settled day as covered. The cache would answer nothing for that kind, the live pass would fill only the live days, and the axis would read **zero on every settled day**: a plausible chart quietly missing most of its history, with nothing anywhere to notice. A hand-written list type-checks fine when the dimension type grows, which is exactly the failure the derivation removes.

### The sentinel

The `built` row is what separates "this day was computed and had no activity" from "this day was never computed". Without it every quiet day misses forever and is recomputed on every request — and the days most likely to be quiet are exactly the ones a wide range is full of.

Two properties of it are load-bearing:

- It is stored under a **reserved repository id of `0`**, and **once per day rather than once per repository**. A repository registered later would otherwise leave every old day permanently unavailable; a repository that did not yet exist contributed nothing, and when it does contribute its own write stamp marks the day stale and the day is rebuilt.
- It is written **last, inside the same transaction** as the day's rows. Its presence is what marks the day usable, so it must never exist without the rows it speaks for — and one axis refreshed beside another still holding last week's values would be worse than an uncached day, because it looks computed.

### The two bounds

- **A ninety-day build horizon.** Not a correctness bound: an older day simply computes live, exactly as every day did before this cache existed. It bounds the work the staleness scan and the build loop can ever do, so a machine with years of history does not pay for a range nobody opens. Four of the five stock ranges sit well inside it; the widest is exactly **equal** to it. Coverage still works out — the build walks the same ninety days back from *yesterday*, and the widest window's oldest day is one day inside that, while its only day past the settled set is today, which is never cached — but "well inside" is not true of that range, and the constant's own note says it is.
- **A fourteen-day budget per build.** The build runs inside the writer's lock, on a path an editor's periodic scan reaches, and that caller waits milliseconds for the lock at most. Falling behind costs a slower page; holding the lock costs someone else's dropped write. So the budget is small and a backlog drains across calls — there is always another call.

### The plan

One scan of the cache per request produces the split every card on the page shares, so the fallback decision cannot come out differently for two figures on the same page:

| Field | Meaning |
| --- | --- |
| Day keys | Every local day the window covers, in order. |
| Cached | The days whose stored rows may be read as they stand. |
| Live | The days that must be computed. |
| Live range | The instants **enclosing** every live day; both zero when there are none. |

**The live set is what a caller must filter on, not merely a hint about the span.** The live range is an enclosing range, so a settled day sitting between two live ones falls inside it, and a row from that day would be added on top of the cached copy already counted. That is the one way this cache can produce a number **larger** than the truth rather than merely staler.

### The cache is never authoritative

Every function here may answer "not available", and the caller must be able to compute the day itself; deleting every row changes only how long a page takes. That property is the whole safety argument, and it is easy to lose by storing something here the sources can no longer produce — so nothing may be written here that cannot be re-derived from the tables it summarises.

The same property is why the table is **excluded from the outbound upload channel**: it is a cache cut in one machine's timezone, so its rows mean nothing on another. Its write stamp is therefore written on every row and read by nothing — no cursor selects on it. It exists for symmetry with every other projected table, and because "when was this row written" is the first question asked when the cache is being debugged. The column's presence is not a licence to put the table on the wire.

### The two source row shapes

Both sides read the same rows through the same queries, and both shapes carry `repo_id` so the cache can store per repository while an all-repositories view sums:

- **A dated usage row** — a repository, a bucketing instant, and the input / output / cached segments at that instant.
- **An axis row** — a repository, a bucketing instant, a series key, a token amount and a cost.

Windows are half-open, and every window bound is applied to **the same expression the row is bucketed by** — never to a write stamp. The two are different questions, and filtering a day bound on a stamp drops precisely the rows a staleness scan exists to find.

### The local-day engine

- **The zone** is the machine's own resolved IANA zone. It is **never request-controllable**: the page request shape omits it entirely, and only a direct in-process caller (in practice, a test) can supply another.
- **A day key** is `YYYY-MM-DD`, read off an hour-cycle-23 wall-clock format of year, month, day, hour and minute — **no seconds**, so all the engine's error arithmetic is minute-granular.
- **Local midnight** inverts the epoch-to-wall-clock map, which is the only direction the platform offers: guess the value, read the guess's wall clock, subtract the target, correct. Up to **three** passes, breaking as soon as the error is zero.
- **A day key is validated by round trip.** The key is resolved to an instant and accepted only if re-deriving the key from that instant returns the input. That is what rejects an impossible calendar date — a request for the 30th of February would otherwise be normalised into March and silently answered with a different day's data.
- **Stepping by days snaps to midnight, then adds twenty-four hours plus twelve, then snaps again.** Landing midday inside the target day is what makes a 23- or 25-hour day unable to skip or repeat; a 36-hour jump would overshoot a whole day when stepping backwards.
- **A step count that is not a finite integer throws.** The loop terminates on inequality, and a not-a-number value is never equal to anything, including itself — so it did not produce a wrong answer, it **hung**, spinning forever inside a synchronous call while holding whatever the caller held, with nothing logged. That is how it presented: a dashboard query that never returned and no slow statement to blame. Throwing rather than clamping is deliberate — a non-integer count means the caller computed one, and a silent fallback would render the default window as if it had been asked for. Nothing reachable trips it today, because range parsing keeps unrecognised input out of the type. (Unreachable at present; the guard is what makes the shared function safe.)

## Behaviors (execution order)

### Deciding which days are usable

A day qualifies when it carries a sentinel **and** no source row belonging to it was written after that sentinel's build instant. Staleness is asked **of the sources**, never recorded by writers: the alternative — every write path recording "this day changed" as it goes — fails the way a ledger fails, since one path that forgets to record leaves a permanently wrong number that nothing detects. A new write path is visible the moment it lands, because the rows it writes carry stamps.

1. **Today never qualifies**, whatever the table holds. It is still accumulating, so a cached copy of it is stale by construction rather than by accident. Days at or after the local today are dropped from the candidate set before anything is read.
2. **Sentinels are read over the enclosing range of the candidates** — one indexed scan rather than a list of up to ninety keys — and then **intersected back against the requested set**. The range is not the question: every production caller passes a contiguous window where the two coincide, but a caller passing two distant days got back every settled day between them, which reads as "these are cached" for days it never mentioned.
3. **The comparand is the oldest build instant in play.** A row written before every candidate was built cannot have invalidated any of them, so it need not be read at all.
4. **The source scan** returns every row that both was written after that instant **and** is dated inside the candidate days' own span. It is **two prepared statements, each carrying a single two-arm union, whose result sets are concatenated** — one for the session-backed sources, one for the memory-backed ones, because the four session-backed axes and the token split read the same two tables while the three memory-backed axes read the same two. Between them the four arms are:
   - per-response usage rows, dated by the response instant and stamped by their own write stamp;
   - sessions, dated by the session's business clock and stamped by the session's write stamp;
   - memories, dated through the shared landing expression and stamped by the memory's write stamp — **without** restricting to root generations, because a write to *any* generation must be visible: re-grounding one is precisely what moves a row into the set the axes count;
   - commits, dated by the committed instant and stamped by the commit's write stamp.

   **Both bounds are load-bearing, and the day bound is what makes the scan affordable.** The build instant decays — a settled day is never rebuilt, so it keeps the stamp it was settled with, and on a machine older than the horizon the oldest one is about ninety days back. Filtered on the write stamp alone, this returned every row written in the last ninety days, materialised into the process and passed one at a time through a wall-clock format call, on the writer's lock once per apply and twice per render. With the day bound the two filters are nearly disjoint in the steady state: the bulk of recently-written rows are dated **today**, and today is never a candidate. What survives both is exactly the interesting set — a row dated in the past but written recently: a re-read of an old session, a backfill, a rebase. On a quiet machine that set is empty.
5. **Each surviving row's day is derived and, if its stamp is strictly greater than that day's build instant, the day is dropped** from the usable set.

   **Strictly greater-than, and at-or-after was considered and rejected.** The build instant is captured *before* the day's rows are read, so any write the build could have missed carries a stamp at or after it — which leaves exactly one row able to slip through: one stamped in the same millisecond as the build clock that also committed after the read began. That is a sub-millisecond cross-process race costing one cached day a stale number until the next write touches it. At-or-after closes that and opens something far worse: a caller with a coarse or pinned clock stamps the rows it writes and settles the day from the same value, so **every settled day reads as stale immediately** and the cache silently stops being used — the one failure mode with no signal at all.

Two fallbacks in this reader handle a stored day key that cannot be resolved to an instant, and both are chosen to be the **widest** range rather than the narrowest: over-reading costs one scan, while an empty range would report every stale day as fresh and a not-a-number bound would hang the day step.

They are unreachable from production — but **not** because the keys come from the day-key formatter. That reasoning is measurably false: the formatter happily yields the key of a day whose local midnight does not exist, and the resolver then rejects exactly that key. What makes them unreachable is that such a day never arrives here in the first place. Any window spanning the transition reaches the forward walk's fixed point before this reader is called at all, and the backwards build walk steps straight over the day, so it is never among the candidates. (Unreachable from production — for a different reason than the one stated in place, which the code repeats.)

### Planning one window

The window is walked day by day from its start to its exclusive end, recording each day's key and its local midnight; the availability check above then splits the keys into cached and live, and the live days' midnights give the enclosing live range. A prior window of equal length — the one the spend card's self-trend compares against — cuts its own plan, because a plan is only valid for the range it was cut for.

### Reading a settled day

Cached rows for one kind over a set of days are summed across the repositories in scope and grouped by day and series key. **Callers must pass only days the availability check returned**; nothing re-checks, because the check needs the whole window at once and doing it per read would make the fallback decision inconsistent within one page.

### Settling a day

Newest first, and the reason is what a reader opens: every stock range ends today, so the most recent unsettled day is the one a page is about to ask for. A backlog therefore shortens from the end that matters, and an old gap nobody looks at can wait indefinitely without costing anyone a slow page.

1. Walk **backwards from yesterday** across the horizon, collecting day keys. Today is never included.
2. Run the availability check over that whole set and take the unsettled days, up to the budget.
3. For each: resolve the day's bounds, read every axis and the token split over `[start, end)` for **all** repositories, and accumulate one cell per repository per series key.
4. In **one transaction**: delete every row for that zone and day, insert the accumulated cells, and insert the sentinel last.

The number of days settled is returned for logging only; zero is the normal steady state and no caller branches on it.

The settle is a **side effect of a write**, and it swallows its own failures: the rollup is derived, so a build that throws must not fail the write that triggered it — the caller's events are already durable and the only cost of skipping is a slower page. The failure worth catching this way is a *standing* one, and the likeliest is structural rather than transient: the settle opens an immediate transaction, which the engine refuses inside an open one, so a caller that ever wraps an apply in a transaction turns every build into a throw. Nothing would break — the page just recomputes every day forever. That is why the skip is logged **at the level the log file records**, not below it: a line written nowhere made this exactly the silent failure the guard exists to report.

One caller running many batches back to back opts out per batch and settles once at the end of the pass, against its final state.

### Forgetting a day

The counterpart to staleness-by-write-stamp. A deleted or moved row leaves nothing behind to notice, so whoever changes it says so. Forgetting a day deletes its cached rows **in every zone present in the table**: a single instant falls on different calendar days in different zones, and the writing process does not know which zones have rows. The table is small and a day dropped needlessly costs one recomputation, so over-forgetting is the intended failure direction. One statement per zone rather than per zone-day, because this is reached once per session event whose usage rows are being replaced and a batch runs it hundreds of times.

The writers that must name their days, and what each one changes that no stamp can report:

- **A session's per-response usage set being replaced.** A response that stops existing takes its day's cached total with it and leaves no stamp; the replacement rows only expire the days that still have responses. The old response days are therefore read **before** the delete.
- **A memory delete.** Read before the delete, because a deleted row cannot say which day it used to contribute to. The self-referencing cascade takes its stored subtree with it.
- **Re-grounding a parked child.** The current-generation predicate every memory axis filters on is "has no parent", so re-grounding *adds* a row to those axes and changes the divisor an apportioning axis divides by — while the statement touches no column carrying a write stamp. Nor can it be left to the batch's own writes: a re-grounded row belongs to a different commit, so its day is typically not among the days those writes invalidate.
- **The alias write on the live path**, and again **on the import path**. An alias moves a memory between calendar days — the landing expression falls through to the aliasing commit once the memory's own commit row is gone — and the alias table carries no write stamp at all. Both callers share one implementation of the days-to-forget rule, which asks the landing query **before and after** the write for every memory the alias touches, rather than deriving the destination: the expression is a fallback chain whose winning term moves as aliases come and go, and reasoning only about the incoming target left a retarget's *outgoing* memory sitting on a day nobody forgot.
- **The unreachable-commit prune**, which forgets both the day left and the day moved to. The commit rows go but their memories survive, so each memory moves to another calendar day, and the destination is asked through the shared landing query **after** the delete — never by restating the rule. It was restated once, as the author date, on the reasoning that the landing expression falls back to it when the commit row is gone. That drops the middle term, and a prune **is** the alias case: the wrong day was forgotten and the day that actually changed was not.

Separately, **forgetting a repository deletes that repository's rows by hand.** The removal path derives its child-table list from the foreign keys pointing at the repository table, and this table deliberately has none — so it is invisible to that derivation, and invisible in the direction that fails *silently*: nothing refuses the repository row's own delete. Leaving the rows behind is not a stale-cache annoyance but wrong numbers, for two compounding reasons: the sentinel is stored once per day rather than per repository, so the day stays settled and keeps serving them; and the all-repositories scope emits no repository filter at all, so a forgotten repository's spend would keep counting there forever, on days that get no further writes to rebuild them. Worse, repository ids are handed out as one past the maximum, so forgetting the highest id lets a brand-new repository **inherit** those rows and carry the ghost into a single-repository view too. The by-hand delete is deliberately not counted in the removal's own child-row tally, since a derived row must not be able to answer "was there anything to remove" on its own.

### The write-side version gate, and the absent read-side one

**The builder declines to settle any day while the file's schema stamp exceeds the build's.** Nothing else in this database refuses such a file — it is opened, read and written normally — but the cache is different: its expiry test reads the write stamps of every source table, and a build that does not know about a table added since cannot see that table change. It would settle a day that is already incomplete and then keep answering with it. Declining costs a recomputation per render; writing costs a wrong number with no signal. The next current build that writes rebuilds the day.

**There is no equivalent gate on reading.** An older build happily reads days a newer build settled, and serves them. (Undocumented asymmetry, not a defect: the read is a plain sum of stored rows, and the read path's own fallback is the same one an absent day gets.)

### The completeness test both sides share

The axes read per-response usage rows so a conversation spanning days contributes to each of them; only one transcript source reports per-response usage, and every other source has nothing but a session-level total under a single timestamp and is still placed by it. Which of the two arms counts a session is decided by one test, used by every axis and the token split, on both the live and the cached side:

**A session is counted by its per-response rows only if those rows account for all of its tokens, and by its session-level total otherwise.** The two arms use exactly that predicate and its exact negation — they are complements, which is what makes the union neither double-count nor drop, and a third spelling on either side re-opens one of the two failures. If the rows somehow exceed the stored total they are the more detailed record and are trusted.

Both halves are load-bearing:

- **The sum comparison** is what an existence test could not do. A partial row set is reachable by construction and is not a parser defect: a session's rows are replaced wholesale, so a producer whose read was cut short writes only its slice, and the commit-summary projection then restores the session-level and per-model figures to the full totals while writing no per-response rows at all — so the one table the charts read is the only one nothing repairs. Under an existence test such a session was excluded from the fallback arm while contributing a fraction of itself to the events arm, and the remainder appeared nowhere on the page.
- **The existence check** is what the sum comparison could not do. Written as the comparison alone, a session with no rows and zero tokens compares as covered and is counted by an arm that has nothing to contribute, so it vanishes from the axis entirely — and the fallback arm's zero-token row is what registers the series **key**. A session with no usage data is a real agent that ran, and dropping it silently removes it from the axis's legend.

### The landing rule

Which day a memory's spend belongs to has **one canonical expression**, valid wherever its two joins — the memory's own commit, and whichever live commit aliases it — are in scope, plus a standalone form for the write paths that must ask before and after a change. It is a constant precisely because several places ask the question and are not allowed to answer it differently: the axes that count the memory, the staleness test that decides whose cached day just went stale, and every write path that has to forget a day outright.

The alias term is what makes them disagree if it is dropped. The staleness test's memory arm used to restate the rule as "the memory's own commit date, else its recorded commit date", which for a **rewritten** commit is a different day entirely: the memory's own commit row is gone, so that spelling fell through to the recorded date — an *author* date, which a rebase can leave a long way from the committer date — while the axis counted the memory on the aliasing commit's committer date. The staleness test then expired a day nothing was drawn on and left the day that really changed serving its old numbers permanently, since an old day gets no further writes.

The axes' own form additionally restricts to root generations, and the staleness test deliberately cannot reuse it: the memory table holds one row per generation, so a re-summarised commit has several and an apportioning window count would count them all — while the staleness test must see a write to any generation. That is why the test composes the shared fragments instead.

## State Transitions

For one local day in one zone:

| From | Trigger | To |
| --- | --- | --- |
| Never computed | A build settles it: rows and sentinel in one transaction | **Settled** |
| Never computed | Read while unsettled | Computed live; nothing is written by the read |
| Settled | A source row belonging to it is written with a stamp strictly greater than its build instant | **Stale** — excluded from the usable set, computed live, re-settled by the next build within budget |
| Settled | The day becomes today's day | **Never usable**, whatever the table holds |
| Settled | A writer forgets it (usage-set replacement, memory delete, re-ground, alias, commit prune) | **Never computed**, in every zone present in the table |
| Settled | The owning repository is forgotten | That repository's rows deleted by hand; the sentinel and the other repositories' rows remain, so the day stays settled |
| Settled by a newer build | Read by an older build | **Read and served** — no gate; that build additionally settles no further day while the stamp is ahead |
| Beyond the ninety-day horizon | Any build | Never settled; computed live on every request |
| A day whose local midnight does not exist | Backwards build walk | **Skipped** — never settled, never attempted |
| A day whose local midnight does not exist | Named as a custom range bound | **Rejected**; the request falls back to the default preset |
| A day whose local midnight does not exist | Forward window walk | **Fixed point** — the walk never advances |
| The day before a day whose local midnight does not exist | Backwards build walk, run on the transition day | **Not a candidate** that day — the walk begins two days back; settled normally by the next day's builds |

For one build attempt:

| From | Trigger | To |
| --- | --- | --- |
| Any | The file's schema stamp exceeds the build's | Declines, logs one line, settles nothing |
| Any | Budget of zero | Settles nothing |
| Any | The build throws | Logged at the file's own threshold; the triggering write is unaffected |
| Any | Every day within the horizon already settled | Settles nothing — the steady state |

## Notable / Surprising Behavior

- **The forward window walk can loop forever, and a render reaches it before any other unbounded walk.** The day step returns the instant it was given for a zone whose spring-forward transition falls at local midnight with a positive offset: stepping one day forward from that day's predecessor lands one hour short of the missing midnight — inside the predecessor's own day — and stepping again returns the identical instant. The walk is synchronous, so no response is produced at all and the whole local service stops serving. Measured across every zone the platform knows, **precisely two** are on this shape, and each recurs annually from **2027 through 2040** — fourteen occurrences each in that span: `Africa/Cairo` on the **last Friday in April**, and `Asia/Beirut` on the **last Sunday in March**. (Surprising; reachable.)
- **The midnight inversion's documented guarantee does not hold in exactly that case.** It is described as landing on the earliest existing instant of the day; measured, for a day whose midnight does not exist it converges on an instant in the **previous** local day — and stepping one day forward from that instant returns the same instant byte-identically, which is the fixed point above. That single fact is the root of every daylight-saving behaviour in this list. (Surprising; the comment is wrong and the code is what ships.)
- **The backwards build walk skips such a day rather than hanging on it**, so it is never cached and never even attempted — which is also why the hang shows up on the read side and not on the write side. (Notable.)
- **On the missing-midnight day itself, the builder's "yesterday" resolves two days back, so one ordinary day goes unsettled for a day.** The walk starts from the local midnight of the current day, which for this day lands in its predecessor, and stepping back one from there reaches the day *before* that — so every build running on the transition day begins at D−2 and the intervening D−1 is never in its candidate list. Nothing is lost: D−1 is settled by the next day's builds, which start from a normal midnight. The cost is one day of live recomputation for that day's readers. (Surprising; bounded.)
- **A custom range naming such a day is silently rejected** in favour of the default preset, because the day key fails its own round-trip validation. (Notable.)
- **The staleness scan asks where a row *is*, so a row that moves between days invalidates the destination and leaves the source cached.** The source day then overstates permanently, because an old day gets no further writes to rebuild it. Reproducible for a session from any source that cannot report per-response usage: its bucketing instant is its own business clock, and moving that clock is a plain update with no day-forget beside it. Sessions from the one source that *can* report per-response usage are safe, because their projection forgets the previous response days before replacing the set. (Surprising.)
- **A protected catch-up import can never expire the day it changed.** Such an import copies bytes from a frozen source, so it deliberately stamps every row it writes at just below the freeze instant — which can never exceed the build instant of a day settled after the cutover, and the expiry test is strictly greater-than. The day therefore stays wrong, and the launcher re-runs that sweep on every start, so it stays wrong every time. The import forgets cached days for its **alias pass only**, never for the memory bodies it writes. (Surprising; two correct decisions composing into a wrong one.)
- **A repository rename is invisible to the staleness test, deliberately.** The project axis stores the repository's display name as its series key and the repository table carries no write stamp, so a settled day keeps labelling its rows with the old name until some unrelated write to that day rebuilds it. Left alone rather than given a fourth stamp: it is a label on the right number, it is self-correcting, and a display name changes about as often as the repository is created. (Notable.)
- **A stale read can be served, and that is the design point** rather than a gap. The cache is never authoritative, every read may answer "not available", and the read path recomputes. There is exactly one direction in which it can be *larger* than the truth, and it is closed by filtering the live pass on day **membership** rather than on the enclosing live range. (Notable.)
- **Today is never cached, however many times the build runs.** A cached copy of an accumulating day is stale by construction. (Notable.)
- **The commit write stamp is not part of this cache but is what the cache needs from the commit side.** Three axes read the commit graph; the memory stamp answers for memory rows and topics are rewritten in the same statement pair, but two things they cannot see are a commit row arriving late (which moves a memory to a different day) and a change of branch membership. The stamp lives on the commit rather than on the membership table because that set is only ever rewritten in the same projection that upserts the commit, and the membership table is the far larger one. (Notable.)
- **The kinds list has no production reader.** It exists to pin the shared namespace against collision, and the test that pins it is only meaningful because the axis half is derived from the dimension type — against a hand-written list, that test asserted only that the list did not contain a name, which says nothing about the type. (Unreachable; deliberate.)
- **The token series-key list has no production reader either.** The builder writes the three keys as literals; the list survives only as the source of their type. (Unreachable; deliberate.)
- **The two unresolvable-key fallbacks in the availability reader are unreachable from production and deliberately widen rather than narrow.** An impossible key degrades to over-reading — one extra scan — instead of declaring stale days fresh, which an empty range would do, or hanging the day step, which a not-a-number bound would do. (Unreachable from production; the choice is what makes it safe anyway.)
- **This table's write stamp is written on every row and read by nothing.** It is excluded from the outbound channel by name, so no cursor selects on it; the declaration's own wording calls it a sync stamp and it is not one. (Surprising.)
- **Removing a repository has to delete these rows by hand**, because the removal path's foreign-key-derived child list cannot reach a table with no foreign key — and this is the only repository-scoped table without one. The omission fails silently in both directions: nothing refuses the delete, and the sentinel keeps the day settled. (Surprising.)
- **The settle swallows its own failures and logs at the level the file records, not below it.** A debug line here was written nowhere, which made a permanently failing build — most plausibly a caller that wrapped its apply in a transaction the settle's own immediate transaction cannot nest inside — completely silent in the one place someone would look. (Notable.)
- **A day is replaced wholesale, never adjusted.** Two axes apportion across a divisor that itself changes, and an arithmetic slip in an incremental update accumulates forever with nothing to detect it. (Notable.)

## Shared Behavior

- The database file, this table's declaration, the migration entry that created it, the permission modes and the per-role write-lock waits are owned by the store and schema topic (347). There is **one** such entry, not a table entry plus a separately-named index entry: it is assembled by concatenating the steps the session-statistics work was developed in, and it therefore carries the `(tz, day)` index **twice** — once inline with the table declaration and once as a concatenated statement of its own. The redundancy is deliberate and kept, because "provably the same statement sequence a machine already ran" is worth more here than tidiness. That topic also records this table as a third declared group whose loss semantics are neither of the other two halves': re-derivable from them inside the same file, so losing it costs page latency and nothing else.
- The write protocol that produces every stamped source row, and that calls the settle after its drain rather than before it, is owned by 354. What it owes this cache is the day-forget above; a write path that deletes, re-grounds or re-aliases a memory row must name the days it invalidated, because none of those touches a stamped column.
- The read model that cuts a plan per window, reads settled days for the token split and the effective axis, and computes the rest live is owned by 353 — including the below-tier axis fallback, which is resolved before the axis reaches either side of this cache so a repository that crosses the tier later cannot find its stored rows holding another axis's data.
- The historical import and per-repository backfill sweep drive the same settle once per pass, hoisted out of their batch loop; their unreachable-commit prune is one of the day-forget writers.
- The cutover fence and the protected catch-up import own the stamping rule this cache's expiry test interacts with; the freeze protocol and the routing that decides whether a repository's memories live here at all are their own topics.
- The outbound session-statistics sync channel owns the exclusion list this table appears on.
- The repository-removal path owns the by-hand delete of these rows and the derived child-table list that cannot reach them.
- The local-day engine is shared with the read model: the day keys, hour buckets, midnight resolution, custom-range validation and day stepping every local-time decision on the activity and standup views goes through are the same code the builder uses, which is what makes a cached day and a live day the same number rather than two numbers that happen to match.
- The row readers, the session-completeness test and the memory landing rule are shared with the live read path by construction, not by convention: the apportioning axes divide by a window count, so a second query with a differently-shaped join would make a cached day and a live day disagree by a fraction nothing would ever flag.
