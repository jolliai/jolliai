# Local coaching dashboard — consolidated design (as built)

**Date:** 2026-08-21
**Status:** as-built reference — the coaching page is shipped; §12's acquisition order is complete.
**Consolidates and replaces:**

- `2026-08-12-local-journeys-dashboard-design.md` (the superseded journeys spec) and its plan.
- `2026-08-15-local-coaching-dashboard-design.md` (the umbrella coaching spec).
- The sixteen per-item plans under `docs/superpowers/plans/` dated 2026-08-12 … 2026-08-16
  (`local-journeys-dashboard`, `journey-activity-duration`, `journey-feed-filters`,
  `journey-trace-fidelity`, `activity-backfill`, `coaching-layers`, `coaching-page-structure`,
  `coaching-spec-completion`, `duration-coverage-route`, `feed-friction-flag`,
  `friction-compaction-capture`, `friction-compaction-render`, `test-first-derive-render`,
  `test-signal-capture`, `trace-attribution`, `trace-waiting`).

**What this document is.** One page's design had fragmented into two specs and sixteen plans. This
is the single authoritative record of the local coaching dashboard **as it now stands**: the premise,
the page structure, every layer's source, the invariants that hold across all of them, and — for each
piece of work — the decision that was made, the measurement that forced it, and what was deliberately
**not** built. It is written in the present tense because the work is done; §12 records the acquisition
order as executed rather than as a plan. Step-by-step TDD mechanics from the plans are not reproduced;
their design rationale is.

**A note on numbers.** Every measurement is dated and labelled with its population level, because a
correction here cost real work. Figures originally measured over memory **rows** (every
amend/regenerate revision) rather than **roots** (one per commit, which is what a journey is built
from) were inflated ~6x, and a threshold was once re-derived from the wrong population as a result. On
the live database the two counts are **2793 rows vs 464 roots**. Unless stated otherwise, figures are
measured on `~/.jolli/jollimemory/jollimemory.db` on the date given (mostly **2026-08-15/16**); this is
a live, continuously growing database, so a re-measurement days later differs by a few percent.

---

## 0. Where this comes from

The journey model, the mark vocabulary and the fidelity ladder are the `jolli` repo's JOLLI-2123
(`b700bad12`, "Add the coaching journey model, dashboards and review axis"). Three documents there are
authoritative for the *model* and are quoted, not paraphrased, wherever this document depends on them:

- `docs/superpowers/specs/2026-08-04-manager-coaching-dashboard-design.md` — what the page shows.
- `docs/superpowers/specs/2026-08-05-coaching-data-axes.md` — where each signal legitimately comes from.
- `docs/superpowers/specs/2026-08-06-axis2-review-index-design.md` — the review index.

The visual reference is the Manager v2/v3 mockup. Every structural claim about it here was read out of
its **DOM and script source**, never off a rendered screenshot.

---

## 1. The thesis: the local constraint is the inverse of the cloud's

### 1.1 Premise: single-subject full parity, not a subset

An earlier framing scoped the local surface as a deliberate subset of the cloud's ("the two surfaces
are complements, not copies"). Product direction is now **full functional parity under a single
subject** — this machine's author. The surface is single-subject *by construction* (§6), so `subjectId`
does not appear in the model at all — not as a constant, not as a nullable field.

### 1.2 What blocks the cloud does not exist here

The cloud's acquisition priority (coaching-data-axes §9) is driven by **transport**: turn-level signals
need plugin work plus a payload extension that does not violate
`BranchShareScope.transcripts = false`. That is why it ranks skill/MCP invocations first as "the
cheapest reliable win" and defers `redShare`/compaction as "fuzziest, lowest confidence".

Locally there is no transport. The transcripts are on the same disk as the reader, so the classification
is not "available / unavailable" but a tier ladder:

| Tier | Meaning |
|---|---|
| **A** | Data already in the database or on the wire. Rendering or query debt only. |
| **B** | One projection or one query change. No new capture. |
| **C** | Requires new derivation from transcripts already on disk. |
| **D** | Requires a source that does not exist on this machine at all. |

Only **D** is genuinely unavailable, and it has exactly one member — Axis 2, review (§12.1).

State at design time (2026-08-15), for context: `session_tool_use` 678 rows (builtin 485, skill 146,
mcp 47); `recall_receipts` 7 rows (thin); `sessions` 1875; `transcripts` 1726; `transcript_sessions`
3135; `memories` 2793 rows / 464 roots; `memory_topics` 14053; `session_activity` 391.

### 1.3 The correction that shaped the honesty rules

The superseded spec pinned `friction` and `waitShare` as "no turn-level red-zone or failure signal
exists locally" **without a measurement**, unlike `review`, which was pinned on hard evidence
(`prNumber` present in 0 of 464 roots — a number, checkable, and correct). Locally the transcripts are
on the same disk; those signals were **underived, not absent** — and both have since been derived
(§10). The lesson is baked into the invariants (§11): a dimension is pinned unavailable only on a
measurement, never on an inference from the cloud's transport constraint.

---

## 2. The journey model (foundations)

These rules are the base the whole page rests on. They were built for the original Journeys view and
carry forward unchanged.

### 2.1 Grouping key

A journey is assembled **at read time, per window, in two passes**. There is no stored journey table
(§2.5).

**Pass 1 — resolve the ticket** (ported verbatim from the cloud's `resolveTicket`):

1. `memories.ticket_id` (i.e. `summary_json.$.ticketId`) if it matches `^[A-Z][A-Z0-9]+-\d+$`.
2. Otherwise the first `\b([A-Z][A-Z0-9]+-\d+)\b` in `commit_message`.
3. Otherwise unticketed.

`TICKET_ID_PATTERN` (`[A-Z][A-Z0-9]+-\d+`) is **the single definition of a tracker key in this repo**
(`JourneyKey.ts`; `grep` must return exactly one definition). The cloud's equivalent bug was two code
paths each carrying their own regex — one strict, one absent — so a reported ticket was trusted
unvalidated while the fallback was picky. Do not add a second spelling.

**The shape gate is load-bearing, not defensive.** Re-measured at root level over 464 roots: 210 carry
a `ticket_id` value at all, of which **148 pass directly** and **62 carry a value that is not a tracker
key**. Representative junk actually in the database (read from the live DB, never invented — see §11):

| Category | Count | Example |
|---|---|---|
| PR number / label | 21 | `#403`, `PR #227`, `PR3` |
| Other junk (no clean category) | 13 | `111`, `Bug 3`, `JOLLI-MEMORY-DISPLAY` |
| Full commit SHA | 9 | `dbda476102e184b3785b1c96a141579991449493` |
| Branch name | 8 | `feature/active-conversations` |
| Plan slug (date-prefixed) | 4 | `2026-07-02-memory-detail-panel-mockup-alignment` |
| Multi-ticket value | 3 | `JOLLI-1050, JOLLI-1053` |
| Ticket-shaped, no number | 3 | `JOLLIMEMORY-CI` |
| Literal placeholder | 1 | `No ticket referenced` |

Ungated, a `"JOLLI-934, JOLLI-959"`-shaped value becomes a journey *named after the string*, which
simultaneously invents a journey that does not exist and steals commits from two that do. Step 2
resolves a multi-ticket value to its **first** ticket — deterministic and explainable, which a bucket
named after the raw string is not. Step 2 recovers **129** of the 316 candidates, leaving **187
unticketed**.

**Pass 2 — group the unticketed.** Count unticketed commits per `(repo, branch)` **within the window**,
then:

```
key = ticket                              → "ticket" journey
    ?? branch, when that branch has >= 2   → "branch" journey  (BRANCH_FALLBACK_MIN = 2)
    ?? commitHash                          → "commit" journey
```

Key namespaces are distinct by grouping kind (`T\x00repo\x00ticket`, `B\x00repo\x00branch`,
`C\x00repoMapKey`), so a ticket literally named like a branch cannot collide with it. `\x00` is the NUL
separator, **always written escaped** — a raw NUL byte makes git treat the `.ts` as binary and kills
diff/blame. The hash is repo-qualified (`commitMapKey(repoIdentity, commitHash)`) because a hash is only
unique per repo.

**Rejected alternative, with the measurement that killed it:** extracting a ticket from the *branch
name*. `feature/jolli-2123-…` really does carry one, but the same pattern reads `update-0`, `doc-0`,
`release-0`, `pr-130` as tracker keys — it recovers 33 commits into 5 keys of which only `JOLLI-1146`
is real (four invented journeys to rescue five commits). `-<digits>` is too common in branch names for
this to pay.

The branch fallback is **not a data-model divergence**: the cloud's `journey_commit_index` already
carries a `branch` column; it simply groups on `${subjectId}:${ticket ?? commitHash}`. The difference is
one expression.

Census under this rule (root level, 2026-08-15):

| Window | ticket | branch | commit | total | memories covered |
|---|---|---|---|---|---|
| 7d | 6 | 2 | 2 | **10** | 29 |
| 30d | 22 | 7 | 16 | **45** | 93 |
| 90d | 53 | 21 | 39 | **113** | 200 |
| all | 136 | 32 | 60 | **228** | 464 |

Strict cloud parity (`ticket ?? commitHash`, no branch fallback) would put **323 single-commit-or-ticket
cards** against 228 real journeys — ~1.4 : 1 noise. The `>= 2` condition is what stops the fallback from
inventing single-commit "branch journeys".

### 2.2 The window changes the grouping, and that is correct

Because pass 1 counts *within the window*, a branch with 8 commits over 90 days but 1 in the last 7 is a
branch journey at 90d and a commit journey at 7d (the census shows it: 21 branch journeys at 90d, 2 at
7d). A journey is *what this piece of work looks like over this period*; change the period and the
boundary of the work legitimately moves. What must never happen is a journey **labelled** as one kind
while grouped as another — hence `groupedBy` is a first-class field, rendered as a distinct badge.
**An inferred grouping must not render as a stated one** (the same rule as "unmeasured is not zero",
one level up).

### 2.3 The three asymmetries (unknown duration)

Ported verbatim from the cloud, and deliberately not symmetric — the question is which direction of
error hurts more:

| Function | Answer on unknown duration | Why |
|---|---|---|
| `frictionIndex` | contributes **nothing** (not 0) | can't tell "smooth" from "unmeasured", so the featured "hardest" card cannot promote a journey we know nothing about |
| `isFeatureWork` | **false** | the threshold keeps trivia out of medians; unprovable ⇒ excluded |
| `deriveJourneyShape` | **not a chore** | the title is the only evidence; defaulting real work to "chore" from silence is a slur, not a conservative guess |

`frictionIndex` deliberately has **no per-person variant and no aggregate caller** — rolling it up to a
person number would be the composite score the coaching contract forbids, arriving by the side door.
`pickSmoothest` takes the friction-minimum among **landed journeys with substance**
(`planFirst || decisionCount > 0`), falling back to plain friction-min only when nothing qualifies —
pure friction-min "crowns a 5-minute typo fix, which is smooth the way an empty road is smooth".
`pickHardest` takes the friction-maximum and, unlike smoothest, an unlanded journey may win.
`JourneyMetrics.ts` is **structurally typed on purpose** — each rule takes the smallest shape it needs,
so it is testable without a DB row and the model can grow fields without touching the file.

### 2.4 The work bar encodes turns, not minutes — and says so

The cloud's bar maps `durationMinutes` onto a width. Locally that renders **most journeys as the same
grey `UNMEASURED_BAR`** — a feed whose primary visual is constant, which is the same as having no glyph.
`conversationTurns` covers the majority of journeys and is a signal the cloud cannot see at all:
**~53 %** at the per-memory level, **~67 %** at the per-journey level (152 / 228 over "all"; a
multi-commit journey counts as measured if any commit reported turns), against duration's ~5.7 %
(§7.1). So the bar encodes **turns**, and because a mark's meaning changed, **every label changes with
it**: `aria-label`, legend and tooltip say *turns*, never *time*. `durationMinutes` survives as its own
field, marked unmeasured wherever null. `UNMEASURED_BAR` is never zero-width (a zero-width bar reads as
an instant) and renders neutral + translucent with `data-unmeasured="true"`.

**`MAX_TURNS = 40` (post-launch recalibration).** The bar's width was originally normalized against
`MAX_TURNS = 120`, a ceiling never reached in practice — measured summed turns per journey (root level):
p50 4, p90 23–30, max 89, none over 120. That put ~¾ of measured bars within a few px of
`UNMEASURED_BAR`, and a low-but-measured count could render *narrower* than an unmeasured one — width is
the channel the reader compares, so a measured journey must never look less measured than an unmeasured
one. `MAX_TURNS` was lowered to **40** (just above the observed p90) with a sqrt scale and a floor raised
strictly above `UNMEASURED_BAR`. Do not re-derive this ceiling from a row-level population again. (The
same `40` is the queue's `SCOPE_TURNS` ceiling, §6-layers.)

### 2.5 Why there is no `journey_commit_index` locally

The cloud needs a derived index because it indexes summary *files* pushed from many machines, which git
cannot query. Locally, `memories` **is** that index: derived, rebuildable, with `ticket_id` / `branch` /
`commit_date_ms` as generated columns and `ix_mem_ticket` / `ix_mem_branch` already built. A second
derived table would repeat the mistake `SotSchema.ts` records on `commits` (A3b): the `ticket_id`,
`commit_insights`, `commit_references` and `session_commit_link` projections were removed because *"a
copy falls behind whenever a memory is regenerated, so the dashboard reads them from the memory tables
instead"*. Consequences: **no schema version bump, no backfill, no projection writer**, and a regenerated
memory is reflected on the next page load. `DashboardModel.schemaVersion` stays `2` — it bumps only when
a view is *removed*, never added. If assembly ever proves slow, the fix is a cache keyed on
`(scope, window)`, not a table; it is not built because no measurement asks for it.

**Assembly correctness facts that are load-bearing, not tidiness:**

- `buildJourneys` and `buildJourneyDetail` share one internal `assemble()`, so the feed and the trace
  group **identically**; `buildJourneys` drops the two heavy arrays (`commits`, uncapped decisions) when
  mapping.
- The main query filters `WHERE m.parent_hash IS NULL` (roots), on a committed-time window
  `[fromMs, toMs)` — inclusive lower, **exclusive** upper, matching `ResolvedWindow`.
- The `readSessionAggregates` **DISTINCT-session subquery is load-bearing**: `memory_transcripts` is
  many-to-many, so aggregating over the raw join sums a session once per (transcript, session) pair —
  `MemoriesQuery.ts` hit exactly this and turned a real `Read ×22` into `Read ×66`. Collapse to distinct
  session identity first, then aggregate. `source` equality in that join matters too: `sessions` is
  unique on `(repo_id, source, session_id)`, so joining on the pair alone is a second fan-out.
- **Reachability is checked in JS, not SQL — it comes from git.** A rewritten history leaves rows behind
  forever; a journey assembled over them would report work no branch carries. Reaching the fold means the
  commit survived reachability. This is also why `landed` was removed (§8.2).
- The newest commit names the journey; `planFirst` is literally plan-*first*
  (`earliestPlanMs !== null && earliestPlanMs < startedAtMs`); a malformed summary body is one unusable
  memory, never a failed page; decisions are split by the canonical `splitDecisionBullets` (imported,
  never reimplemented — a private copy would render literal `**` here and clean everywhere else); the
  feed caps each row at `FEED_DECISION_CAP = 8` while `decisionCount` carries the true total ("a cut this
  page cannot see is a cut it would silently misreport").

---

## 3. Page structure

### 3.1 View identity: keep `journeys`, relabel to Coaching

`"journeys"` appears in a handful of non-test TypeScript sites plus `assets/js/shell.js`, and is **not
persisted** in telemetry or the schema. Renaming is possible and deliberately **not done**: the
identifier is not user-facing, the nav label and page title are. Those two are **Coaching**;
`/dashboard/journeys` keeps working and existing deep links do not break.

### 3.2 The model is additive

`JourneysModel` is unchanged. A new layer wraps it:

```
CoachingModel {
  roster    : CoachingRoster       // the single subject's row + rollup cells
  adoptNext : AdoptItem[]
  queue     : QueueItem[]
  patterns  : PatternsModel
  hero      : { date, costUsd, turns }[]   // the expansion's trend
  featured  : { smoothest, hardest }       // whole journeys, not ids (§3.4)
  journeyCount, indexedCommits, windowStartMs, windowEndMs
}
```

The feed's `JourneysModel` deliberately **does not ride here** any more (§3.4). This is load-bearing for
cost: the shipped feed, featured pair and trace keep working unmodified; moving the feed behind a modal
is a container change, not a data change.

### 3.3 Layout, mockup → local

| Mockup | Local |
|---|---|
| `ADOPT NEXT` card | same (rules-derived; narrative deferred, §6-layers) |
| `Coaching queue` | self-directed action items |
| roster, one row per report | **one row, expansion permanently open** |
| ↳ expansion: hero trend + `jSmooth` / `jHard` | the featured smoothest/hardest pair **moves here** |
| `team patterns` | same, with a redefined evidence bar (§6-layers) |
| "Open the N journeys →" | feed modal → row click → trace modal |

Render order (§3.3 layout, built in `coaching-layers`): **ADOPT NEXT → queue → roster (+expansion) →
patterns → feed button.** The featured pair's placement is not a preference: in the mockup
`jSmooth(p)` / `jHard(p)` render inside the roster row's expansion (`if(open){ … <div class="mgxp"> … }`),
not in the feed modal.

### 3.4 Fetch boundary: aggregates inline, feed on demand

Measured on the live page (all repos, default window, 35 journeys): the whole inline page model is
**107.1 KB**, of which `journeys` is 106.5 KB (**99 %**) and decision text alone 81.0 KB (**76 %**);
whole-page HTML 286.9 KB. Once the feed is behind a modal, that 106.5 KB is content most page loads
never open — the same argument the code already makes for keeping the trace out of the model.

So: the server assembles journeys once (every top layer derives from them), **inlines only the
aggregates**, and serves the feed from `/api/journeys` fetched when the modal opens. One consequence is
handled rather than discovered: `smoothestId` / `hardestId` are ids on `JourneysModel`, but the featured
cards render in the roster expansion on first paint — so the inline aggregate carries **the two featured
journeys' own records**, not just their ids, or opening the page would require fetching the feed anyway.

`/api/journeys` is deliberately **not cursor-paged** (unlike `/api/memories`). Two feed functions are
defined over the *complete* set and would silently degrade against a page: `JD.journeyFilters` derives
which chips exist from the journeys present, and `JD.shouldGroupByDay` decides on the header count across
the whole set. Paging would make both answer from whatever happened to have loaded, with no error
anywhere. Paging can be added later behind the same URL once both take an explicit total.

**Window bounds travel as `fromMs` / `toMs`, never `from` / `to`.** The server's `parseWindow` already
claims `from`/`to` for the range picker, where they are date strings, so epoch ms under those names is
silently misread. Both bounds or neither — one bound alone is a window nobody computed. The bounds are
carried from the model the roster rendered under, not re-resolved: two `resolveWindow` calls can straddle
local midnight and group a different set, which would also 404 the detail route for a row the feed had
just drawn. The same rule fixed a latent trap in `openTrace`, which must take its bounds from
`JD.feedModel` (the `JourneysModel` whose grouping produced the clicked row), not from the page model.

`resolveWindow` / `ResolvedWindow` and `machineTimeZone` are **exported from one place** — the range
chip, the feed and the detail route must compute the same window and the same zone, or the grouping
(window-dependent, §2.2) silently changes what a journey *is*.

---

## 4. Single-subject semantics

### 4.1 The anti-ranking rules become structural

Under a single subject, two of the mockup's three anti-ranking rules stop being rules and become facts:

| Cloud rule (verbatim) | Single-subject |
|---|---|
| "a sortable stat column is a ranking with a click" | vacuous — one row |
| "Pattern rows carry no names — patterns rank, people never do" | vacuous — one person |
| "every trend is that person against their own earlier line … never their standing next to anyone else" | **survives, and is the only comparison axis available** |

The cloud spends design effort *forbidding* cross-person ranking; locally it is unrepresentable. Nothing
sorts: the feed order is `endedAtMs` descending and stays that way. Day grouping is a change-detect walk
over the already-descending feed (§5), never a re-sort.

### 4.2 Relational marks change referent, never assertion strength

The mockup's rule: waits read `"waiting on <name>"`, never `"idle"` — "the agent's idleness is measured,
the human's activity is not." Locally the subject is the reader, so the wording is **"waiting on you"**,
and the parenthetical survives verbatim and is the point. Wordings that assert what the human was doing —
`idle`, `away`, `blocked on you`, and also `drove` — are **forbidden**. This is easier to get wrong
locally, because addressing the reader about themselves feels licensed.
`"no land renders neutral, because punishing hollow dots teaches junk commits"` carries unchanged.

### 4.3 The roster row and its cells

The roster is one `<tr class="roster-row">` labelled **"You"**, with its expansion permanently open
(hero trend + featured pair). Its cells (`CoachingQuery.buildCoaching`, computed from `buildJourneys`
over the window and the immediately preceding window of equal length, so every trend compares the same
population and the same clock):

| Cell | Source | Notes |
|---|---|---|
| **plan-first** | `LocalJourney.planFirst` share, 0–100 | trend is a difference in percentage **points**, not a percentage of a percentage |
| **skills** | `session_tool_use` where `kind='skill'` | value + `topName` + `distinctCount`; availability from the capture boundary (below) |
| **cost** | sum of `LocalJourney.costUsd` over the window | trended against the same journeys, **not** a re-sum of `sessions.est_cost_usd` — that shape produced "$0.00" with "+200%" beside it and was removed once (`DashboardQuery.ts:1124`) |
| **recall** | `session_tool_use` where `kind='mcp'` and the tool is recall | matched by `isRecallMcpToolName`, never equality — a plugin server namespaces the row (`plugin_jolli_jollimemory.recall`), and equality reports zero forever on those installs; SQL narrows with a suffix `LIKE`, the JS predicate decides |
| **turnaround** | median activity minutes over journeys with measured duration | `unavailable` (never 0) when no journey has measured duration — an unmeasured turnaround is not an instant one |
| **friction** | window-aggregate turn-aborts (§10-friction) | distinct abort instants across the window, cross-journey de-duped |

**Availability is three-state** (`RosterAvailability = "measured" | "partial" | "unavailable"`), and the
client renders `—` for anything not `"measured"`. `partial` is the load-bearing one: a window that opens
**before a signal began being captured** produces a real but unrepresentative number, indistinguishable
on screen from "this person does not do that". Tool-use capture began part-way through this database's
history (first `session_tool_use` row; ~93.9 % session coverage in the last 30 days, ~12.3 % over all
time), so the skills and recall cells derive availability from that boundary. A trend is **never
rendered as `+0%`** — no trend is not a zero trend.

Two roster counters stay absent unless actually measured: `flaggedCount`'s denominator is journeys whose
friction is *measurable* (a window with none is "flagging was never measured here", not "0 flagged"),
and `awaitingCount` (journeys whose longest wait ≥ `WAIT_STALL_MINUTES = 30`) stays absent unless at
least one journey's wait was measured.

---

## 5. The feed: filter chips and day grouping

Both are pure client-side rendering over the model already fetched, in the **only forms local data
supports**.

**Chips (shipped `50d7a4e`).** The mockup's chips are `flagged` and `no land`. Neither had a local input
at first — `flagged` needs friction (tier C, then underived) and `no land` needs `landed` (removed,
§8.2) — and either would render a filter that silently matches nothing, which is worse than no chip. The
substitute is the **plan-first split**, the one distinction that is both measured and actionable and the
practice ADOPT NEXT exists to push. Measured on the live database: **229 journeys, 55 plan-first, 174
straight to execute.** `JD.journeyFilters` yields keys `all` / `plan-first` / `straight` (label "straight
to execute"); `MATCHERS` is `all → true`, `plan-first → j.planFirst`, `straight → !j.planFirst`; unknown
keys fall back to `all`. A `flagged` chip was **later added** (`feed-friction-flag`) once friction was
derivable — see §10-friction.

Chips filter the **feed only** — the featured pair keeps ranking the whole window, because its subtitle
says it ranks the window and a "smoothest" that moved on every click would be a different claim each
time.

**Day grouping (shipped `89261fb`), capped at `DAY_HEADER_CAP = 31` HEADERS.** A density rule was written
first and the measurement killed it: journeys per active day is **2.2 / 2.4 / 2.2 / 2.1** for
7d / 30d / 90d / all — flat, so density cannot tell the windows apart. Header counts do:
**5 / 19 / 52 / 110** against 229 rows. The cap admits the windows a reader scans day by day (7d, 30d),
excludes the ones they skim (90d, all), and decides a custom range by its own shape rather than by a
hardcoded range name. Grouping runs over the **filtered** rows (a day whose journeys are all filtered out
emits no empty header) and the cap is evaluated against that same filtered set — so a window that does
not group unfiltered can start grouping once a chip narrows it (the 90d window's 52 header days sit above
the cap, but narrowing to `plan-first` drops it under). This is intended.

**The rendered-index invariant.** The row click handler resolves the **rendered** array by index, so both
the filter and the interleaved day headers must leave that index intact. Day headers are **concatenated
onto a row's own markup** rather than emitted as separate elements for exactly this reason. Getting it
wrong opens the wrong journey's trace, which looks like it worked. (This failed silently twice.)

---

## 6. Coaching layers: adopt-next, queue, patterns

All three are **rules over `model.journeys`** — the same journeys the roster derives from, never a
second read of `memories` — assembled from **fixed templates, no LLM, recomputable and offline**. No
layer's *existence* may depend on an LLM being configured; an LLM pass that rewrites template sentences
into prose is a later phase, and when it exists a failure degrades to the template sentence, never to a
blank. An empty window yields empty arrays, and the client renders **nothing** for an empty section —
never a "0 patterns" claim.

**ADOPT NEXT** (`buildAdoptNext`, `ADOPT_WINDOW = 5`). One item per recommendable practice; today only
plan-first. Over the last N journeys (`endedAtMs` descending, so a front slice is "the last N"):
`adopted = count(planFirst)`, template **"M of your last N journeys planned first"**. Skipped when the
window is empty. The mockup's `"est. −13h/wk"` figure needs duration and is **not built** here — it
belongs with the duration work item.

**Coaching queue** (`buildQueue`) — self-directed items, each carrying the source journey as an evidence
link (a `<button class="jqlink">` opening the trace modal by id):

1. **plan-first** — when fewer than half the window's journeys plan first: "Write a plan before your next
   feature", evidence = the most recent non-plan-first journey.
2. **scope** — when any journey has measured **`turns ≥ SCOPE_TURNS` (= 40, the glyph's `MAX_TURNS`)**:
   "Break large work into smaller journeys", evidence = the highest-turn journey.

Each rule emits at most one item; a journey is not duplicated across items unless it genuinely wins both.

**Patterns** (`buildPatterns`). Behaviour patterns over the window's journeys, each reporting how many it
matched and how many distinct ISO weeks they span (`localWeekKey`, keyed by the local Monday). Patterns:
`plan-first`, `straight-to-execute`, `single-commit` (`commitCount === 1`), and **`test-first`**
(`tested?.testFirst === true`, §10-tests). A **zero-count pattern is dropped** — the absence of a
behaviour is not a pattern, and "0 of your journeys were X" is the same lie the em dash avoids.

**The evidence bar is redefined for a single subject (§3.4 of the umbrella; new here, not ported).** The
cloud's bar hides a pattern "under 4 journeys **or 2 people**" in the Emerging row; the people clause
stops one person's idiosyncrasy becoming a team pattern, and can never hold locally. The local analogue
of that risk is **one period's idiosyncrasy becoming "your pattern"**, so a pattern renders outside
Emerging only with **≥ `EVIDENCE_MIN_COUNT` (4) journeys spanning ≥ `EVIDENCE_MIN_WEEKS` (3) distinct
ISO weeks**. This substitutes spread-in-time for spread-in-people. `established` / `emerging` each sort by
count descending, then key.

---

## 7. Duration: a correctness bug before a coverage problem

### 7.1 The displayed figure was inflated 7.6–26x

`session_activity` — fifteen-minute activity buckets — **already exists and is populated**. Comparing
both measures on the sessions carrying both (2026-08-15):

| Messages | Raw span `sessions.duration_ms` | Buckets × 15 min | Inflation |
|---:|---:|---:|---:|
| 42 | 4409 min (73.5 h) | 210 min | **21.0x** |
| 38 | 1674 min | 210 min | 8.0x |
| 28 | 1356 min | 135 min | 10.0x |
| 10 | 1173 min | 45 min | **26.1x** |
| 26 | 1137 min | 150 min | 7.6x |
| 6 | 426 min | 30 min | 14.2x |

Sessions are routinely resumed after hours of doing something else, so the raw start-to-last-message
span "wildly overstates presence" — a conclusion this repo already reached for the concurrency figure and
then left the Journeys view reading the old column. Observed consequence: a journey whose first and last
commits were 44.8 minutes apart reported **22 046 minutes**, being five resumed sessions' spans summed.

### 7.2 Activity buckets are the sole duration source

`durationMinutes` is the **union of distinct 15-minute buckets** across a journey's deduped sessions —
**union, never sum**: two sessions active in the same quarter-hour are one quarter-hour of work, and
summing would reintroduce the exact inflation this removed. One named function,
**`journeyActivityMinutes(buckets) = buckets.size × 15`**, is the **sole definition** for every consumer
(feed work bar, featured cards, roster hero/turnaround, trace meta line, adopt-next estimates); no call
site reads `sessions.duration_ms` directly. `ACTIVITY_BUCKET_MINUTES` is fixed by the writer, never a
tuning parameter. This needs **no migration and no new capture** and slightly *improves* coverage.

`readSessionBuckets` builds a map keyed by `sessionActivityKey(repoIdentity, source, sessionId)`
(`\x00`-separated) — **repo-qualified**, because the map is built globally across every repo where
`(source, sessionId)` is not unique, and an unqualified key would silently merge two repos' buckets. A
session with **no** activity rows is **absent from the map, not present with an empty set** — "no
evidence" and "measured zero activity" are different claims, so a journey whose sessions are all absent
reports `null`, never 0.

**Two honesty constraints ride along.** The bucket count is an **upper bound** — one utterance in a
quarter-hour fills it — which is the price of a measure needing no idle-gap threshold, so every label
says **"activity", never elapsed time / "took" / "duration"**. And the three §2.3 asymmetries are defined
over "unknown duration" and are unaffected, but every threshold calibrated against the old inflated figure
was re-derived: `frictionIndex`'s divisor became `FRICTION_DURATION_CEILING` (journey-level p90, rounded
up to a multiple of 15) and `isFeatureWork`'s floor became `FEATURE_WORK_MINUTES` (journey-level p50,
rounded up to 15) — read straight off a measurement through the changed `buildJourneys`, with
`pickSmoothest`/`pickHardest` orderings re-derived from the new constants (never the reverse).

A **source-shape test** (`DurationSource.test.ts`) pins that no file under `cli/src/dashboard/**` reads
`duration_ms` except the sole definition — a unit test cannot see a call site that bypassed the helper.
Two measured facts shape it: `duration_ms` legitimately appears in five non-test dashboard files
(`SotSchema`, `DashboardDb`, `StatsWriter`, `DbBackfill`, and `DashboardQuery`'s Stats-page
`legendarySessionMinutes`), so the allowlist is explicit; and `JourneysQuery.ts` names it in two doc
comments explaining why it is *not* the source, so comments are stripped before scanning. The allowlist
is **bidirectional** — an entry that stops matching also fails, forcing the list to shrink when the last
use is removed.

### 7.3 Coverage, and the backfill that raised it

Journey-level coverage — the figure the feed actually shows, one row per journey — was **13 of 229
(5.7 %)**, far below the ~11 % session-level figure, because a journey needs only one covered session and
most carry none. The cause (measured 2026-08-16): `activityBuckets` (and `started_at_ms`) are
**capture-age-gated** — the writer began emitting them in August 2026, so **1660 of 1876** sessions have
NULL `started_at_ms` and carry no buckets *by construction*. Every `session.upserted` event carrying
`activityBuckets` (549 events: bootstrap 276 / vscode 154 / stop-hook 119) arrived in 2026-08; none
earlier.

**Route A was taken** (`backfillStoredActivity` in `DbBackfill.ts`): backfill activity buckets for the
~1566–1570 sessions that have a **stored transcript** but no buckets, computed from
`transcripts.sessions_blob`'s per-entry timestamps via the **shared `bucketsFrom` primitive**
(`ActivityBuckets.ts`, never a private copy, so backfilled and live buckets cannot drift). It runs once
at the end of `dbBackfillRepos` (whole-DB, after every repo imported), in batch-bounded transactions,
idempotent (`INSERT OR IGNORE`), presence-gated (`bucketsFrom` returns `[]` when no entry carried a
timestamp → no rows, never a fabricated zero-bucket session), and **never throws** (a failed backfill is
a warning, not a failed import). It reaches **~94 % of the reachable gap (1566 / 1660)**.

**Route A does NOT project a span.** §4.4 of the umbrella once proposed projecting
`started_at_ms` / `ended_at_ms` onto `transcript_sessions`; but §7.1 measured that a first-to-last span
overstates presence 7.6–26x, so a span-projecting backfill would re-introduce the bug §7.1 fixed. The
honest backfill computes **buckets, not span**. **Route B (widen the writer) was measured out**: the
writer already tries to compute buckets on every read and sends `undefined` only when the transcript is
unreadable. The residual after Route A is **94 sessions** (claude 93 + copilot 1), every one with its
live JSONL gone from `~/.claude/projects/` (Claude's retention cleared them) — unrecoverable by any
route, because no writer change can read a file that no longer exists. Nothing to widen.

The **distinction from the "no repair path" note** in `DbBackfill.ts` (`SESSIONS_READ_GENERATION`,
"accepted rather than deferred") is deliberate: that note is about the **concurrency** figure, whose
source is live agent transcripts and which does not claim to answer for last month. The stored-transcript
backfill is a different source and a different consumer (the duration figure, which *does* claim to
answer for historical journeys); it does not touch live discovery or change what the writer emits.

---

## 8. The trace sheet

Every element is **Tier A** — the data is already on the wire in `JourneyDetail`; nothing new is
captured, queried or migrated. The sheet renders in **SVG with CSS classes**, exactly as
`JD.journeyGlyph` does — **not** the mockup's inline `css("--accent")` lookups, which read computed styles
at render time and do not follow a theme change.

### 8.1 Shipped elements

- **Meta line** (`JD.renderJourneyMeta`, shipped `167712c`) — weekday date, `durationMinutes` as
  "N min activity", `sessionCount`, `costUsd`, a shape label, and a badge showing `ticket` only when
  `groupedBy === "ticket"`, else `branch`, else "no ticket" (a branch journey cannot pass as a ticket
  one). The `#jtraceSub` container that holds it was **deliberately deleted** in `535f8889a` as "markup
  nothing populates"; this **re-adds** the element with a populator, and must not be mistaken for
  restoring something lost by accident.
- **Stage band** (`JD.stageBands`, shipped `9dae230`) — a **pure function returning data**
  (`[{key, label, share}]`, shares summing to 1), so widths are assertable without parsing SVG. Its only
  real input is `planFirst`. Exact bands: plan-first `frame 0.12 / plan 0.18 / execute 0.5 / verify 0.2`;
  not-plan-first `frame 0.1 / execute 0.65 / verify 0.25`. **Never a `land` band** (§8.2). The widths are
  a **narrative frame, not a measurement** — stated in the aria-label ("stage bands are a narrative frame,
  not measured phases") and never derived from a timestamp.
- **Time axis + commit placement** (shipped `59c68b5`). SVG constants `TRACE_WIDTH = 560`,
  `TRACE_HEIGHT = 96`, `AXIS_Y = 64`, `BAND_Y = 16`, `BAND_H = 18`. `commitX(committedAtMs, startedAtMs,
  spanMs)` places each commit; callers must not reach it with a zero span (division by zero → `NaN` →
  SVG draws **nothing**, a silently empty chart).
- **Decisions on the axis** (shipped `7b490e1`) — each decision placed at **its own commit's** time via a
  `byCommit` lookup (rendering them all at the origin would draw every decision as taken before any work
  happened). **A decision naming a commit outside this journey is dropped, not clamped**, and stays in the
  full uncapped list below the axis. Decision diamonds are **always filled**: hollow means `agentAlone` in
  the cloud's vocabulary, and local decisions carry no attribution evidence — a hollow diamond would
  accuse the agent of deciding alone on no evidence.

### 8.2 Two hard constraints, and the single-commit fallback

**No `land` band, ever.** `landed` does not exist on the model — it was removed post-launch because it
was structurally always `true` (unreachable rows are filtered out before the fold, so every commit that
reaches it survived reachability by construction). `DashboardModel.ts` states the rule it violated:
"a structurally-always-true field is the same lie in the other direction." Drawing the band claims every
journey landed; drawing the not-landed variant claims the opposite; **omission is the only honest
option**. Making `landed` real is bounded, separately-decidable work — the existing
`readReachableCommitsByRepo` answers "reachable from some branch", while `landed` needs "reached the
**default** branch": a `git rev-list <default-branch>` walk per repo plus resolving what the default
branch is (§13). A test pins that no stage-band variant ever emits `land`.

**Zero-span / single-commit fallback.** A commit-grouped journey has one commit, so
`endedAtMs === startedAtMs` and the axis has no length — about **60 of 228 journeys (~¼)** are
commit-grouped, so this is not an edge case. Such a journey falls back to the **ordinal list**
(`<ol>` of ordinal + first message line + 7-char hash), drawing no axis. An axis whose ends are the same
instant would read as work finished instantaneously.

Other trace conventions: the overlay is toggled with the `.open` **class**, never the `hidden` attribute
(`main.css` has `.overlay{display:none}` / `.overlay.open{display:flex}` and the attribute is defeated by
`display:flex` — note this differs from the VS Code webview, which does use `.hidden`; the two surfaces
share no stylesheet); a failed read says so explicitly ("Could not load this journey.") because a silent
empty sheet reads as "this journey has nothing in it"; markup must never emit a raw NUL.

---

## 9. Marks that are drawn vs pinned

Every mark stays gated on `availability`; an unmeasured signal draws **nothing**, never a zero-length
mark (a measurement claim nobody made):

| Mark | Local behaviour |
|---|---|
| Work bar | encodes **turns** (§2.4) |
| Session separators | `sessionCount - 1` — kept |
| Decision diamonds | drawn, **always filled** (§8.1) |
| Wait marks | rendered in the trace as a "Waiting on you" list (§10-waiting) |
| Friction / red zone | roster chip + feed `flagged` chip + trace context-load list (§10-friction) |
| Review tick | **not drawn** — Axis 2 is Tier D (§12.1) |

---

## 10. Tier-C signals, as built

All are **read-time** derivations (Divergence 6 — no index table), **window-scoped** (never the full
1677-transcript corpus §7 refuses), and **forward-only**: a new `StoredSession` field is absent on old
memories and on sources that cannot see the event, and consumers read absence as "not recorded", **never**
as "none". `sessions_blob` is zlib-JSON, so none of these needed a migration; only **Claude and Codex**
emit the capture events. A **single shared read helper**, `readJourneySessions(db, accumulator)`, returns
the deduplicated `StoredSession[]` (dedup transcripts by `transcript_id`, first wins), so a transcript
linked to several commits of an amend chain is read once and no derivation double-counts. `buildJourneys`
walks transcripts only when the caller opts in via `options.withFriction` / `withTests`, and **only the
paths that need it opt in** (`/api/journeys` for the feed `flagged` chip; `buildCoaching`'s window build
for test-first). The page-load roster path stays cheap.

### 10.1 Waiting (§12 step 3 — highest-confidence Tier C)

`deriveWaits` walks adjacent `assistant → human` entry pairs; a gap `≥ WAIT_THRESHOLD_MS (5 × 60 000)`
records one `WaitPeriod { startedAtMs, endedAtMs, durationMinutes }`. Five minutes is a documented local
choice (no spec constant) — a shorter gap is reading/typing, not waiting. A missing/unparseable timestamp
skips the pair (never clamped to 0); waits are sorted ascending and de-duplicated on `(startedAtMs,
endedAtMs)`. `availability.waitTiming` stays pinned `"unavailable"` — waits are computed on demand for the
trace only, never eagerly for every feed journey. Rendered as a `<h4>Waiting on you</h4>` list; empty →
no section; the wording is always **"waiting on you"**, never `idle`/`away`/`blocked on you`. **Known
gap, recorded:** `startedAtMs` is the assistant turn's start, so a wait slightly over-counts the agent's
own generation time; tightening to turn-end needs a per-turn duration no source exposes.

### 10.2 Attribution (§12 step 4)

`deriveAttribution` sums `role === "human"` and `role === "assistant"` turns across `entries` into
`TurnAttribution { humanTurns, agentTurns }` on `JourneyDetail`. Rendered as "You: N turns · Agent: M
turns" when ≥1 turn; empty → no line. **Counts turns, never verdicts** — never "you drove / the agent did
most of the work" (§4.2). **Known gaps, deferred with reason:** the lane/delegation-line visualization
needs the mockup's DOM this repo does not carry; `agentAlone` (the hollow diamond) stays deferred because
decisions are LLM-extracted summaries with no turn mapping; and a duration-weighted split needs per-turn
durations no source exposes (so a long agent chain weighs equally with a short human "yes").

### 10.3 Friction — compaction + turn-aborts (§12 step 6)

Two turn-level signals the parsers previously **parsed then dropped** are now persisted on
`StoredSession` (capture, `friction-compaction-capture`): **compactions** (Claude `isCompactSummary`;
Codex `compacted` / `context_compacted`) and **turn-aborts** (Codex `turn_aborted` only), each a
de-duplicated, sorted array of epoch-ms instants, absent when a line has no timestamp (a `0` is never
written). These are the only turn-level signals that are **not heuristics** — explicit events, hence
first among the C tier.

Rendered (`friction-compaction-render`) on two surfaces, and the **two friction numbers are not the
same**:

- **Roster friction cell** — `buildWindowFriction` counts distinct turn-abort instants across the whole
  window, **cross-journey de-duped**, over the same grouping the roster's other cells use. `deriveTurnAborts`
  returns `{ measured, sawUnmeasuredSource, count }`; `turnAbortsCell` is the single availability mapping:
  `measured && !sawUnmeasuredSource → {measured, value}`; `measured && sawUnmeasuredSource → {partial}`;
  else `{unavailable}` — **never a 0**. Friction is **Codex-only**, and `StoredSession.source` is what
  distinguishes a Claude session (not a friction source) from a Codex session written before the field
  existed (a friction source we could not measure) — a window with both a measured and an unmeasured Codex
  session is `partial`. Wording: "N aborts" (singular "1 abort"), red accent for non-zero, neutral for
  zero — the measured fact, never a verdict about the person.
- **Feed `flagged` chip** (`feed-friction-flag`) — a **per-journey** abort count, **no cross-journey
  de-dup** (answers "did *this* journey have friction"). Attached per journey via
  `buildJourneys(..., {withFriction})`, which only `/api/journeys` opts into. **Positive-evidence only:** a
  journey is flagged iff its friction is measured and non-zero; a `partial` journey is flagged only when the
  measured subset shows an abort (a zero there is "no positive evidence", never "no friction"). The chip is
  **availability-gated** — it renders only when at least one feed journey has measurable friction, so an
  all-Claude window renders **no** `flagged` chip (a "flagged 0" would be the §5 failure a filter that
  silently matches nothing).
- **Trace context-load list** — compaction instants, positioned on the axis by timestamp and **dropped
  outside the journey's span** (like decision diamonds), heading **"Context load"** (never "auto-compact"
  as a bare noun — the instant is what is drawn). `deriveCompactions` yields `[]` when absent or empty
  ("empty, never absent", the contract `waits` has), so the trace renders nothing rather than a false "0
  compactions". A screen-reader list section renders whenever `compactions` is non-empty, because
  `role="img"` hides the SVG `<title>`s — and it survives even a zero-span journey (the record survives
  when the axis does not).

**Not built:** the glyph's `glyph-red-zone` / `glyph-flag` marks (a per-journey glyph mark is a separate
surface); and Claude friction beyond `turn_aborted` (heuristic tool-retry extraction — the fuzziest tier,
needs a real-transcript fixture per §11 before any parser; not blocked, just unstarted).

### 10.4 Test signals (§12 step 5)

A **test run** is an epoch-ms instant the agent invoked a test runner in a shell command — a
**conservative heuristic**, pinned to real transcript fixtures before the parser was written (§11), and
captured only from Claude (`tool_use` `name:"Bash"`, reading `input.command`) and Codex (`function_call`
`name:"exec_command"`, parsing `payload.arguments` JSON `.cmd`). The single matcher
**`isTestCommand`** (`TestCommandDetect.ts`, one definition so it cannot drift between parsers) recognises
a runner only as a **command word** (at start or after `&&` / `;` / `||` / `|`): PM subcommands
(`npm test`/`t`, `pnpm test`/`t`, `yarn test`, `bun test`, `deno test`, `make test`), runner binaries
(`vitest`, `jest`, `mocha`, `pytest`, `rspec`, `phpunit`, `pest`, `go test`, `cargo test`/`nextest`,
`mix test`, `dart test`, `flutter test`, `dotnet test`, `bazel test`), and prefixed runners
(`npx vitest`/`jest`/`mocha`/`playwright test`, `python -m pytest`/`unittest`). It must **not** fire on a
runner token used as a substring of a non-test word (`cat test.txt`, `grep vitest`, `vitest-config`).

`deriveTested(sessions, startedAtMs)` finds the earliest test-run instant and compares it to the first
commit — a journey is **test-first** when a run happened *before* its first commit (`planFirst`'s
structure, with the earliest `testRuns` instant replacing the plan row). Because `testRuns` is
forward-only and source-gated, the verdict carries **availability**: `measured` (a real true/false),
`partial` (some reporting sessions, some unmeasured — `testFirst: true` is still positive evidence,
`false` is "no positive evidence"), `unavailable` (no verdict, never a `false`). It renders as **one
coaching pattern** ("Test first"), `planFirst`'s own smallest surface, under the same §6 evidence bar.
**Not built:** a roster column, an adopt-next item or a feed chip for test-first — those follow once the
pattern shows the signal is meaningful; §3.3 names no test surface, so a pattern is the honest first
render.

---

## 11. Verification

### 11.1 Three blind spots measured while designing this

Each produced green tests over broken production code, and each generalises:

| Blind spot | Rule |
|---|---|
| The asset test harness parses attributes out of the rendered HTML **string** with a regex, never an HTML tokenizer — so NUL → U+FFFD replacement, which corrupted a journey id in production, is unreproducible in it | Invariants about markup must be **parser-independent**: assert the rendered markup contains no raw NUL, rather than asserting what `getAttribute` returns |
| `toContain("fromMs=…")` passes just as happily inside the malformed URL `/api/journey&repo=…` | URL assertions check **shape** (`startsWith("/api/journey?")`), never substring presence alone |
| `index.html` declared `journeys.js` while `DASHBOARD_SCRIPT_FILES` omitted it; both agreed and both were missing the file | Any list duplicated across files needs a pinning test (`PluginDashboardAssets.test.ts` is the pattern) — the unit suite passed while the page threw `JD.renderJourneys is not a function` |

### 11.2 Invariants that have tests

Ordered by how silently they fail.

1. **One duration definition** (§7.2) — a source-shape test: no file under `cli/src/dashboard/**` reads
   `duration_ms` except the sole definition; bidirectional allowlist.
2. **An unmeasured signal never renders as zero** — per mark, with its dimension `unavailable`: the mark's
   element is absent and its figure slot reads the unmeasured wording, not `0`. Assert on the slot, not the
   whole document ("10 commits" contains a zero).
3. **Vocabulary guard** (§4.2) — wait wording is "waiting on you"; the output must not contain `idle` or
   any wording asserting the person's activity. A string-level test, because this can only decay by
   rewording.
4. **Patterns evidence bar** (§6) — one case each side of "≥ 4 journeys over ≥ 3 distinct weeks".
5. **No `land` band** (§8.2) while `landed` does not exist.
6. **Anti-ranking** (§4.1) — no sort control on the roster; trend arrows compare only against the
   subject's own past.
7. **Fetch boundary** (§3.4) — the inline page model contains no journey feed, with an asserted size
   ceiling.
8. **`TICKET_ID_PATTERN` is defined exactly once**; `SotSchema.ts` is unchanged (`git diff --stat` empty).
9. **The window changes the grouping** — the same commits are a branch journey at 90d and commit journeys
   at 7d.

### 11.3 Definition of done

- **§7.1** — the `feature/manager-dashboard-2` journey drops from **22 046 min** to the order of its
  44.8-minute commit span. The executable clause is **not** "no journey's activity exceeds its own commit
  span" — work precedes its commit and a single-commit journey has a zero span, so that wording is wrong;
  do not restore it. The real check lives one level down: **no session's activity may exceed its own
  bucket span** — `COUNT(DISTINCT bucket_ms) * 15 <= (MAX(bucket_ms) - MIN(bucket_ms)) / 60000 + 15`,
  grouped by `session_event_id`. Measured 2026-08-15: 0 sessions fail it.
- **Tier A rendering** — each element checked against the mockup's **DOM**, not a screenshot, and each new
  element availability-gated.
- **Tier C derivation** — each signal class pins a **real transcript fixture** before its parser is
  written. This repo has already paid for the alternative: an imagined parser plus an imagined fixture form
  a self-consistent loop that is entirely wrong. (The `test-first` matcher was pinned to two real lines on
  this machine before it existed.)
- **Route A** — no migration; `session_activity` pre-exists. (Had the retired span route been taken,
  `MigrationFingerprints.test.ts` would have been updated for fingerprint and order in the same change.)

### 11.4 Test tiering

Dashboard tests are in the fast tier. New cases touching real SQLite or real git
(`ActivityBackfill.test.ts`, `FeedFriction.test.ts`, the real-SoT derivation suites) go into
`SLOW_TEST_FILES` explicitly, or they degrade `npm run test:fast`, the inner loop. `assets/js/*.js` is
plain JavaScript `tsc` never sees, so a renderer reading `model.cost` when the model sends `costUsd`
produces `undefined` in the browser with no compile signal — every field name is checked against
`LocalJourney` and every renderer has a test; the `.test.ts` files themselves are linted.

---

## 12. Acquisition order, as executed

The cloud's sequencing principle was adopted verbatim, because it is about trust rather than transport:
"coaching built on noisy signals erodes trust faster than no coaching" — explicit signals before
heuristic ones. All seven steps are **done**:

| Step | Work | Status |
|---|---|---|
| 1 | Tier A rendering debt (meta line, time axis, stage band, shape chips, day grouping, roster columns) | done (§5, §8) |
| 2 | §7.1 duration correctness (activity buckets) | done |
| 3 | Waiting / turn ordering | done — trace "Waiting on you" (§10.1) |
| 4 | Attribution (human vs agent) | done — trace "You / Agent" turns (§10.2) |
| 5 | Test signals | done — capture + `test-first` pattern (§10.4) |
| 6 | `redShare` / compaction + friction | done — capture + trace markers + roster chip + feed `flagged` (§10.3) |
| 7 | §7.3 duration coverage | done — Route A backfill; Route B measured out |

### 12.1 Tier D, in full

**Axis 2 (review).** `summary_json` carries no `prNumber` (0 of 464 roots), and the `context` reference
rows hold one GitHub row in total — an issue link, not a PR. The cloud's `coaching_review_event` anchors
on `(repoUrl, prNumber)`; neither half is obtainable. The dimension stays **kept and pinned**
(`review: null`, `reviewTiming: "unavailable"`, no review mark drawn) so a future source is a population,
not a redesign. Acquiring it means integrating an external source (`gh`, or a PR number captured at commit
time) and is out of scope.

---

## 13. Divergences from the cloud

| # | Divergence | Forced by |
|---|---|---|
| 1 | Roster is one row, no tier gate | attribution: 232 / 236 attributable root memories are one author |
| 2 | `branch` fallback for unticketed, when ≥ 2 in window | §2.1 (323 single-commit-or-ticket cards vs 228 real journeys) |
| 3 | Work bar encodes turns, relabelled, `MAX_TURNS = 40` | duration ~5.7 % vs turns ~67 % of journeys (§2.4, §7) |
| 4 | Decision diamonds always filled | no `agentAlone` evidence; per-decision attribution not derivable (§10.2) |
| 5 | `review` pinned null | §12.1 |
| 6 | Read-time assembly, no index table | §2.5 |
| 7 | No `land` band in the stage band | `landed` removed as structurally always true (§8.2) |
| 8 | Duration is activity, not elapsed span | §7.1 |
| 9 | Patterns evidence bar is ≥ 4 journeys over ≥ 3 weeks | the people clause cannot hold (§6) |

---

## 14. Remaining / out of scope

Deliberately not built, each recorded so a later reader meets the reason rather than the absence:

- **Tier D review tick** (§12.1) — needs a PR number captured at commit time or an external source.
- **`landed` made real** (§8.2) — a default-branch `git rev-list` walk per repo per render; cost
  unmeasured. Until then divergence 7 stands and the `no land` feed chip cannot exist.
- **Claude friction beyond `turn_aborted`** (§10.3) — heuristic tool-retry extraction, the fuzziest tier;
  needs a real-transcript fixture per §11 before any parser.
- **Glyph `glyph-red-zone` / `glyph-flag` marks; a roster column / adopt-next item / feed chip for
  test-first; the lane/delegation-line visualization; `agentAlone`** — each a further surface whose signal
  is now captured but whose render is a separate, data-backed decision.
- **ADOPT NEXT's `"est. −13h/wk"`** — needs duration coverage; ships the adoption share only for now.
- **Narrative phase** (§6) — deferred, no date; sentences stay template-assembled, no LLM. Whether it runs
  per page load, per commit, or on demand is undecided and affects cost.

Open questions still live:

0. **"clean land" says in words what the `land` band may not say in a mark.** §8.2 omits the band because
   `landed` does not exist, but `deriveJourneyShape` ends three of its four labels with `· clean land`, and
   the trace meta line prints that label two elements from where the band would have been. The claim is
   vacuous rather than false (every rendered journey survived the reachability filter), but a vacuous claim
   rendered as fact is the failure this document keeps naming. The label is shared with the feed
   (`JourneyMetrics.ts`), so resolving it means trimming the suffix in both places or stating why a label
   may assert what a mark may not.
1. **`recall_receipts` is thin** (7 rows). Whether the roster's recall column is meaningful yet, or should
   be withheld until the table fills, is unresolved.
2. **Whether `sessions.duration_ms` has other inflated readers** outside the dashboard. Not surveyed;
   §7.2's source-shape test is scoped to `cli/src/dashboard/**`.
3. **The Stats page's `legendarySessionMinutes` is very likely inflated by the same 7.6–26x**
   (`DashboardQuery.ts` derives it from `MAX(sessions.duration_ms)`). Out of scope here — this document is
   scoped to the coaching path — and `DurationSource.test.ts`'s allowlist records that reader deliberately,
   as a known, tracked exception rather than an oversight.
