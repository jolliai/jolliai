# 353. Dashboard Read Model Query Layer

## Topic Statement

How one dashboard page payload is assembled from a read-only database handle: the envelope every view shares, the three axes every view is asked along — a repository scope, a resolved time window, and a series dimension — what each view's payload answers, the one paged list and its cursor contract, and how a failed read degrades.

## Scope

**In scope:**

- The payload envelope: the fields every view carries, and the rule that exactly one view payload is built per request.
- The three shared axes and how each is resolved before any query runs: scope token → repository key, requested range → concrete window, requested dimension → the axis actually used.
- The single time-zone engine every local-date decision goes through, and why the database's own local-time functions are never used.
- The adoption tier, how it is detected from the data, and which payload fields it gates.
- What each view answers, field by field, and which of its figures are windowed, which are not, and which are absent rather than zero.
- The memories list's **cursor** pagination contract, including the answer when the cursor's row has vanished.
- The single context-document read that serves a memory's plan / note / reference / skills body.
- The one field on the whole read model that is derived by a language-model call, its cache (failures included), and what its absence means.
- Per-card degradation: which read failures are swallowed and what the reader sees instead.

**Boundaries (consumed here, owned elsewhere):**

- The transport — routes, methods, request parsing, the security layers, and the two conditions that suppress the model-spending read (spec 352). This spec covers only what the model contains and how it is derived. In particular the view name arrives already resolved: the accepted set of names is wider than the set of served pages by exactly the settings payload (which is delivered to a modal, not a page), and a name outside the set resolves to the **activity** view.
- The database schema, its tables, the connection policy, and the runtime floor that gates opening it at all.
- The write path that fills those tables (spec 354) and the import/backfill sweep that seeds them.
- The cutover routing that decides whether a repository's memories live in this database at all.
- The repository registry file this layer joins against, the identity derivation behind it, and the configuration/hook-status settings assembly that is **unreachable at HEAD** (spec 355).
- The browser application that renders these payloads (spec 356).
- The summary tree, its token aggregation, its cost estimate, and the reference/skill display helpers this layer reuses so the memory detail reads identically to the editor's.

## Data Contracts

### The payload envelope

Every payload carries the same envelope, plus exactly one view payload:

| Field | Meaning |
| --- | --- |
| `schemaVersion` | `4`. The browser compares it against the version inlined into its own page and **reloads** on a mismatch rather than re-rendering — see *The payload version is a breaking-change counter* below. |
| `view` | The view this payload was built for: `stats` (the activity dashboard), `standup`, `memories`, `knowledge`, `graph`, or `settings`. |
| `tier` | `installed` or `memory` — detected from the data (below). |
| `generatedAtMs` | The clock this payload was built against; every relative time in the page is measured from it. |
| `timeZone` | The IANA zone every date key and hour bucket in this payload was computed in. |
| `scope` | The **normalized** scope — a `kind` of `all` or `repo`, and in the second case a **list** of repository identities — echoed back so the page and the numbers agree. |
| `repos` | Every repository the picker offers, ordered by display name: identity, display name, checkout root, sessions in the last 7 local days, and three optional state markers (below). |
| `coverage` | Zero or more honesty notes, each `{ kind, message }`. |

The view payloads are the view names above minus the two folder-backed ones — one present, the rest absent. Building the others would be wasted queries, and the page only reads its own. The knowledge and graph views' payloads are not built here at all: they read the Memory Bank folder rather than the database (366).

#### The scope is a LIST, and one field carries it

A `repo` scope carries `repoIdentities`, an array — usually of one — and there is deliberately **no** singular field beside it. Two spellings of one fact would leave a reader of a scope unable to tell which one a given producer filled in, and a deep link would carry that drift silently. A `repo` kind with an **empty** list reads as *every* repository, matching a request that omitted the parameter entirely; it is not a way to select nothing.

#### The picker's per-repository state markers

Three optional markers, each present only when true, so an ordinary active row's shape is unchanged:

- **Paused** — the repository's disable timestamp is set. Paused rows are **carried, not dropped**: pausing is an update that stamps a column rather than a delete, and those repositories keep counting in the aggregate figures, so hiding them made an all-paused dashboard read as "no repositories yet".
- **Missing** — the recorded checkout no longer exists on disk. Also **marked rather than filtered**, for a different reason: a deleted checkout keeps its memories and those are worth reaching, so what must not happen is the row presenting itself as a working checkout when every action on it names a directory that is not there. It is also what gates the row's forget control — the page offers to remove an entry only once it can say the entry is dead.
- **Volume unavailable** — nothing could be found because the *volume* is absent (an unplugged drive, an unmounted share) rather than because a folder was deleted. It implies missing and is never set alone. Two states rather than one, because an existence check cannot tell them apart and the row used to assert the wrong one — saying "folder missing" and offering to forget a repository that was merely unplugged. The extra ancestor walk this needs runs **only** for a row already found missing, so rendering a working repository still asks the filesystem nothing extra.

### Axis 1 — repository scope

A scope is either **all enabled repositories** or a **named set** of them — one or more (see *The scope is a LIST* above). Each token in that set is resolved before anything reads it, in this precedence:

1. An exact **identity** match wins. It is the stored key, so it can never be shadowed by a repository merely *named* like someone else's remote.
2. Otherwise a **display name**, accepted only when exactly one repository carries it. Two same-named repositories leave the token unresolved and log a warning rather than picking one — a plausible-looking URL showing the wrong project's numbers is worse than an unfiltered page.
3. A row id is deliberately **not** accepted: it is assigned by insert order, so a bookmarked link could come back pointing at a different project after a database rebuild.

Each resolved token is then turned into a surrogate key once per query function. A token no repository matches resolves to a key that **matches nothing** — an unknown repository has no data, and widening to every repository would be a silent lie. The same holds for a set: unresolvable members contribute nothing rather than relaxing the filter.

### Axis 2 — time window

The requested range is one of `today` (1 local day), `week` (7), `2w` (14), `month` (30), `3m` (90), or `custom`. The default when none is given, and the fallback when a custom request is unusable, is **`month`**.

A preset window ends at tomorrow's local midnight (exclusive) and starts N−1 local days back. A custom window carries an inclusive `YYYY-MM-DD` pair, resolved as:

| Input | Outcome |
| --- | --- |
| Either bound missing | Falls back to the default preset. |
| A bound that is not a real local day (wrong shape, or a date the calendar does not have) | **Rejected** — falls back. A day key is validated by resolving it and checking the resolved instant's own day key matches, which is what catches a normalized non-date. |
| A reversed pair (`from` after `to`) | **Rejected** — silently swapping would answer a question nobody asked. |
| `to` in the future | **Clamped** to today. |
| `from` more than **366** local days back | **Clamped** to that ceiling — a scan bound, not a retention statement. |
| Both clamps crossing (the whole request sits beyond one of them) | Falls back to the default preset. |

Whichever was asked for, the payload echoes the window it actually used as `range` plus inclusive `rangeFrom` / `rangeTo` day keys. A range control that kept displaying a rejected or clamped input would misreport which window the numbers cover.

### Axis 3 — series dimension

The activity view's series is split along one of `model`, `agent`, `project`, `branch`, `ticket`, `category`; the default is `model`. The last three read memory-enriched data, so **below the memory tier they silently fall back to `model`** — a stale link renders real data instead of an empty chart pretending to be one. The payload reports the dimension actually used, so the page's chips cannot claim an axis the numbers were not built along.

### The time-zone engine

Every local-time decision — day boundaries, day keys, hour buckets, streaks — is computed in one zone (the machine's, unless overridden), never by the database's own local-time functions, which answer with the process's zone at query time and cannot agree with the boundaries computed here. Rows are filtered by UTC millisecond range in SQL (index-friendly); bucketing happens afterwards.

Local midnight is derived by inverting a wall-clock read: guess the UTC value, measure the error, correct, repeated up to **three** times. On a day whose midnight does not exist (a spring-forward transition) this lands on the earliest existing instant of that day. Stepping by days steps through midday rather than adding 24-hour multiples, so 23- and 25-hour days cannot skip or repeat a day.

## Behaviors (execution order)

1. **Resolve the zone and the clock.**
2. **Normalize the scope** before any builder reads it, so every query and the echoed-back scope agree on one identity.
3. **Build the repository option list** — every repository with no disable stamp, ordered by display name, each with its session count over the last 7 local days. This rides in the envelope so the shell needs no second round trip.
4. **Build the coverage notes**, which are **per view, not global**. Only the activity and standup views get one, because the note describes session/commit activity and would be a statement about something the reader is not looking at anywhere else. With no sessions recorded at all it reads "No sessions recorded yet — data appears after your next AI session."; otherwise "Older activity is reconstructed from commits and stored summaries; recent sessions are exact." There is deliberately **no in-progress-import note** on any view.
5. **Detect the tier.** The tier is `memory` when either any stored memory carries turns, tokens, or a ticket id, **or** any memory topic carries non-blank decisions or todo text; otherwise `installed`. Alone among the figures in this payload it is **machine-wide, not scope-filtered** — so a repository with no memories of its own renders at the memory tier as soon as any *other* registered repository has one, and every field the tier gates (the capture count, the decisions card, the standup insight block, the memory-only axes) switches on for it.
6. **Build exactly one view payload.**

### The activity view

Two windows are in play: the **selected** window, and a fixed **84-day** (12-week) sweep ending today. The sweep is the long view by construction and is never collapsed by the range control.

- One sweep of sessions and commits over the 84 days feeds the heat map, the hour histogram, the records, and the streak. When the selected window sits **inside** that sweep, its rows are filtered out of what is already in memory; a custom window reaching outside it pays for its own scan.
- **KPI row** (all over the selected window, each labelled with the window so a figure cannot be misread as today's): session count; tokens (input + output + cached); estimated cost; **% cached**, whose denominator is *input + cached* rather than the total, rendered as an em dash when that denominator is zero; and the streak.
  - Token magnitudes render as one decimal plus `k` at or above a thousand, one decimal plus `M` at or above a million.
  - The **streak** is consecutive active local days ending today — or ending yesterday, since a morning where you have not started yet does not break one. A day is active if it carries a session or a commit *within the 84-day sweep*.
- **Series**: one point per local day across the whole window (empty days are seeded, so gaps are real points rather than missing ones), each carrying total tokens, estimated cost, and a per-series-key token split. Values are rounded at emission rather than per row.
  - The `category` axis reads memory **topics**, sharing each memory's tokens and cost evenly across its topics — a per-commit "dominant category" erases every category that never wins a commit's vote. A memory with no topics still lands on the axis, wholly under `(uncategorised)`.
  - The `branch` axis apportions the same way across the branches a commit is reachable from: the branch set is a per-branch union, so every commit on the trunk is also listed under every feature branch based off it, and unapportioned a single commit multiplied the day's totals.
  - The `ticket` axis does **not** apportion; commits with no ticket group as `(no ticket)`.
- **Token breakdown**: input / output / cached over the window, plus a per-day series of the same three.
- **Cost trend**: percentage change against the immediately preceding window of equal length. Absent when that prior window has no priced sessions, so no trend is ever claimed against a zero.
- **Heat map**: one cell per day of the 84-day sweep with sessions, **commits** and tokens. Commits are their own dimension because sessions older than the live-log window survive only as stored summaries, so a commit-only day must not render as inactive.
- **Hour histogram**: 24 buckets of session counts by local hour of the sweep.
- **Records**: longest session by duration (with its title and, when known, its turn count), the biggest token day of the sweep, and the night-owl share — sessions at local hour **21** or later, over all sweep sessions.
- **Session feed**: the newest **20** sessions **of the selected window** (not the sweep), each marked live when it was updated within the last **10 minutes**.
- **Memory feed**: the newest **20** root memories of the window that git can still reach. Selection is two-step — key rows first, filtered, then the payload blob read only for the page actually rendered — because reachability can only be decided outside SQL and filtering a limited page would show the two survivors of the twenty newest rows rather than the twenty newest surviving memories. Each card carries: the commit subject, the dominant topic category, a `major`/`minor` **severity derived from diff magnitude** at a threshold of **200** changed lines (nothing stored says major or minor), the first recorded decision line else the recap, cost, turns, insertions/deletions, branch, and the **working** model — the one with the most output tokens, deliberately not the model that wrote the summary.
- **Capture counts**: `totalCommits` is every commit in the window regardless of reachability (it answers "what did I do"), while the captured count is reachability-filtered and counts commits that have a memory **row at all** — including one reached through a rewrite alias, since a rebased commit's memory stays filed under its pre-rewrite hash. Using turns/tokens instead would count a sparse-but-real memory as a gap. The captured count and the decisions card are absent (not zero) below the memory tier, so the card can render a dash instead of asserting a real zero.
- **Decisions card**: decisions mined from the window's commit memories — a count, the number of distinct repositories they came from, the newest one, and a per-day count series. Its per-day map is seeded across the window like the token series.
- **Tool usage** and **recall usage**, below.

#### Tool, skill and MCP usage

All of it is windowed by **the call's own time when the parser that read it could stamp one, and by its session's last-update time otherwise** — one expression used on both bounds of every range test, so a row cannot be admitted by one clock and excluded by the other. A stored zero is treated as "no time known" and falls back to the session's clock, because a bare zero would otherwise read as a real epoch-0 instant and leave every window.

- **Skills** and **individual MCP tools**, each with the sessions that called it and the total calls, ranked by **adoption (sessions) first, volume second**, and cut at **8** rows. A single session hammering one tool 200 times is not evidence the tool matters; a tool reached for across many sessions is.
- **MCP servers** get their **own** grouping rather than a roll-up of the per-tool rows — summing double-counts a session that called two of a server's tools, and taking the maximum undercounts two sessions that each called a different one. Also cut at 8.
- **The recall tool's own row** is pulled from the untruncated set before that cut, and matched against **every spelling** of the tool name: the bare `<server>.<tool>` form, or any namespaced form ending in the same tool under a plugin-prefixed server. An equality test on the bare name reported "no recall calls" forever on a plugin-registered install. It is reported under the canonical name, summed across spellings.
- **Coverage** is computed from the full session population, never from the join: sessions with at least one recorded call in the window, over sessions **admitted by either clock** (their own update time *or* any call they made in the window). Both halves are load-bearing — session time alone cannot see a session whose calls landed in the window while its own timestamp did not (so a ranked row would sit above "from 0 of 0 sessions"), and call time alone drops a session that made no call at all from the denominator the caveat is built on.
- **Uncovered sources** names the sources present in the window whose transcripts *cannot* record tool calls — read from the parser contract, not from "happened to record none". A readable source that used no tools is deliberately absent: its zero is a real zero.
- **Every row also carries which agents made those calls**, ranked most calls first, using the same raw source tag every other axis shows. And the shape of that breakdown is **deliberately asymmetric**, in a way that is the whole point of it:

  - **A per-row agent share carries CALLS ONLY, never a session count.** A session belongs to exactly one agent, so both figures partition cleanly *at the grouping they were counted at* — but a session count does not survive being re-summed at a coarser one, and this breakdown appears at three groupings. A session that called two of a server's tools is one session for the server and two rows in the per-tool grouping, which is exactly the double-count the servers' own separate grouping exists to avoid. Carrying a number that is exact on the skill rows and a double count on the server rows would be worse than carrying none.
  - **The per-kind agent totals do carry sessions**, because they come from their own distinct-count grouping rather than from a re-sum — so they are answering a question that was actually asked of the database, not one reconstructed from rows.

  This is the same discipline as the servers' separate grouping, applied one axis over: where a figure cannot be re-derived correctly from finer rows, it is either queried at its own grouping or omitted.

#### Recall usage — RETIRED as its own payload

There is no recall payload on this model any more, and no Recall card to consume one. What survives is a **single row inside the tool-usage payload**: the recall tool's own call row, pulled from the untruncated set before the row cut and matched across every spelling of the tool name (see *Tool, skill and MCP usage* above). It is absent when the window holds no matching row — which also means it misses a bare command-line recall and the skill's non-model-protocol fallback, since neither produces a tool row at all.

Everything the retired payload computed is gone with it: the used / set-aside split and served percentage, distinct memories served and their age, the session-coverage numerator and its union denominator, skill-invocation counts, the two independent no-receipt estimate channels and the larger-of-two rule, the skill-runs-with-no-other-trace subtraction, the daily used / set-aside series with its per-day lower-bound estimate, and the unwindowed first-receipt day. The receipts themselves are still written and still stored — this is a reporting surface being withdrawn, not a capture being switched off.

### The daily standup view

A fixed two-day board — yesterday and today, by local day boundaries — with **no** range axis and **no** model call of any kind.

- **Commits** are filtered to the local git identity: email compared case-folded (git does not normalize them, and the same person legitimately appears under a work address locally and a noreply address after a remote rewrite), name compared exactly (a name is display text, and two people can differ only by case). Either matching admits the commit.
- That filter **fails open**. An identity with nothing usable in it yields no filter and the board shows every author's commits — a blank standup reads as "you did nothing", which is a worse lie, and the unfiltered case is visible because the payload states whose commits are shown. The `authoredBy` label is derived from the *same* identity by the *same* emptiness rule, so it can never claim a filter that did not run; it is **absent** when the board is unfiltered.
- **Sessions and workspaces carry no author filter and need none** — an agent session and an uncommitted diff are this machine's own working state, so they are already first-person. Only commits can hold a teammate's row.
- **Workspaces** are the per-branch dirty-state rows with any non-zero change, observed within the last **24 hours**. Stale rows are dropped rather than shown: the row asserts "there is uncommitted work on this branch right now", and only another observation of the *same* branch can correct it, so a committed, abandoned or deleted branch would keep claiming changes forever.
- **Insights** are present (possibly empty) from the memory tier onwards and absent below it. They are derived **at query time from each memory's own topics** — a `decision` row for each topic with non-blank decision text, a `todo` row for each topic with non-blank todo text, ordered by topic position with decisions ahead of todos. A rewritten commit's insights are reached through its alias, exactly as the decisions card does; without that an amended commit's insights would vanish here while its decisions still rendered on the other card. Rows are then re-sorted into a fixed render order: blocker, question, gotcha, todo, decision.
- Each insight carries the instant its commit landed — the only date on record, and the right one: an unanswered question is as old as the commit that asked it.

### The repositories view — RETIRED

There is no repositories view and no payload for one. The page it fed is gone (356), and the registry's list now reaches the browser as the `repos` picker array in the envelope above rather than as a view of its own.

Two of the retired payload's rules are worth keeping on record, because the figures they governed are no longer computed anywhere on this model and a future surface that wants them will have to re-derive them:

- **Memory counts had to apply the same two rules the memories browser applies**, or a badge and the tree reported different totals for one repository: only **root** memories count (the store is a tree, so an amend or squash files the follow-up as a child and a plain count inflates every repository by its rewrite history), and git reachability drops roots no local branch can still reach. Reachability is not expressible in the query language, so hashes were fetched and filtered outside it — and a caller that did not pay for that computation got the unfiltered count, because the check fails open.
- Session counts were derived live from the detail rows rather than from a stored aggregate.

What the picker array carries instead is deliberately much smaller — sessions in the last 7 local days, plus the three state markers — because it exists to let someone *choose* a repository, not to report on one.

### The memories view

Two parts: a list page plus vitals, and — only when the request named a hash this scope can resolve — one memory's full detail.

**List rows** are root memories (no parent), newest first, filtered by reachability. The sort is the **committer** date, falling back to the memory's own recorded commit date only when no commit row exists yet: those are two different clocks (the memory records the *author* date), so a rebased or cherry-picked memory would otherwise sort and render differently in the tree than in the activity feed listing the same memory. **The commit hash is the second sort key and is load-bearing**, not cosmetic: two memories can share a timestamp to the millisecond, and the page cursor is a position in this exact order.

Each row: repository identity and name, full hash, its 7-character short form, an optional human-facing memory id (present only after a successful push), the commit subject, branch, committed instant, ticket, category label, and a synced flag.

**The category label** on a list row (and on a standup commit row) is the **mode** of that commit's stored topic categories, ties broken toward the earliest-appearing topic. It is keyed by repository **identity**, never display name — two registered repositories can share a name, their hashes overlap by construction, and a name-keyed map painted one repository's label onto the other's rows.

**The activity feed's memory card does not use that label**, and the two can disagree. It recomputes the category from the *assembled summary's* topics with a plain most-frequent pick and no earliest-topic tiebreak, so a commit whose two top categories tie can be labelled one thing in the memories list and the other on the dashboard card. (Surprising; the feed's own header claims the rule is shared.)

**Vitals** are three counts: memories (the reachable root total), topics, and repositories represented. Only the first is filtered at all — the repository count is taken over *every* memory row, children and unreachable ones included, so it can name more repositories than the tree beside it shows.

#### The pagination contract

The page size is **250** rows, and it is a page budget rather than a cap: the whole model is inlined into the served page, so an all-repositories scope cannot ride there whole, but the tree's search box filters the loaded array in the browser, so a hard cap would quietly turn "search my memories" into "search my recent memories".

- The list is paged **on the last row the client holds, never on an offset.** The set is reachability-filtered at request time, so it *shrinks* under a rebase mid-browse; with an offset every row after the vanished one moves up a slot and the one landing on the boundary falls inside the already-loaded range and is never shown again. A gap is the failure mode that matters, because a client can dedupe a repeat but cannot notice something it was never sent.
- `totalCount` is the reachable total, so `items.length < totalCount` is the client's "there is another page" test — no separate truncation flag to keep in step with it.
- **A cursor whose memory is gone** gets the **first page** plus a `cursorMissing` flag — not an empty page (which would strand the tree at what it had) and not a silent restart (whose rows the client's dedupe drops, leaving a button that visibly does nothing). The flag is what lets the client re-seat itself.
- The listing query carries no SQL limit or offset at all, for the same reason: a row the reachability filter drops would make a database-level window skip a different memory on every page. Every row is fetched, filtered, then sliced. (Single-row reads elsewhere in this layer — picking one memory's detail, fetching one document — do bound themselves in SQL; it is the *paged list* that cannot.)

#### The memory detail

Built only for the hash the request named. When the request also names an owning repository, that token narrows **the detail only** and deliberately does not touch the page scope — carrying it into the scope collapsed the tree to one repository as the price of opening one memory. The owning token goes through the same name-or-identity resolution as the page scope, and a token that resolves to nothing falls back to the page scope rather than to a filter that matches nothing: the hash still identifies the memory, and showing it beats an empty pane. In an all-repositories scope where one hash matches two repositories, the pick is **ordered and deterministic** rather than whatever the engine returns first.

The detail is assembled from the memory **tree**, not the bare row: a root's stored payload has its children emptied, and an amend or squash carries most of its conversation tokens (and, on legacy data, its topics) on those folded children. It falls back to the bare row if tree assembly finds nothing, so the pane never fails on a tree query.

Beyond the identity and header values a list row already carries (repository, full and short hash, title, branch, author, committed instant, ticket, category label, synced flag, per-commit diff counts) plus the recap, the **derived** fields are:

| Field | Derivation |
| --- | --- |
| `memoryRefId` | Always present here, unlike a list row: it falls back to a hash-derived handle so every memory is named the same way the editor names it. |
| `tokens` | Aggregated over the tree. The headline is **not** the sum of the three segments — a folded session reporting a scalar count with no breakdown lands in the total and in no segment — which is also why the bar's widths use the segments' own sum as their denominator. The segment sum is the fallback headline for the one shape the aggregate cannot describe. |
| `tokens.costUsd` | The same whole-tree estimate the editor's meter runs, not the root's own stored cost, which prices only the tip of a consolidation. `pricesAsOf` stays the root's stamp. |
| `summarizedBy` | The model that **wrote** this memory, and its tokens — distinct from the conversation tokens above. |
| `conversations` | Four fields per row — title, source, archived message count, and the agent's own **session identifier**, which is on the payload solely because it is the row's tooltip: the other three cannot tell two conversations from one source apart, and a title that fell back to a first user message can make two rows near-identical. It is also the editor's own row identity, so the two surfaces name a row the same way. Reassembled from the **archived** transcripts, not from a link join: the join listed one conversation per transcript file (an amend chain files a slice per commit), and the live message count keeps growing after the commit while the count a memory should show is the turns archived *into* it. Titles resolve archive-first, then the live session row, then the archived first user message — the archived string is the only one that survives session pruning or arriving on another machine. **Row order comes from the summary's own transcript array**, because the link table is a set whose natural order is an arbitrary id; the editor reads that array, so ordering by it is what makes the two surfaces agree. A linked id the array does not name keeps its query position behind the named ones rather than being dropped. |
| `context` | One ordered list — plans, notes, references, then a single skills row — never a list per kind, so the page cannot render them in a different order than the editor does. Reference titles and secondary lines use the same display rules the editor uses. |
| `context[].contextKey` | What the document read needs. A plan's archived slug, a note's archived id, `<source>/<sanitized-key>` for a reference, and **the commit hash** for the skills row (whose table is rendered from the summary, not stored). Absent when it cannot be derived — a reference whose source has since left the registry renders as a plain, unopenable label rather than a button that always fails. |
| `excluded` | Context the relevance ranker soft-excluded, with its reason. |
| `activity` | Per-tool call counts across the memory's linked sessions. The session set is resolved to **distinct** sessions *before* the tool rows are joined; without that, one session listed in several of the memory's transcript files multiplied every count by the number of files (two amends turned a real 22 into 66). MCP rows are labelled by server, everything else by tool name. |
| `activityUncoveredSources` | Same honesty check as the activity view, scoped to this memory's linked sessions. |
| `topics` | Each topic's title, category, trigger, response, todo and files, with the decision prose split into bullet lines by the same splitter the feed card's one-liner uses, so the two can never disagree about what one commit's decisions were. |
| `files` | Per-file insertions/deletions from the collector's own pass. **When there are no such rows at all** — a repository enrolled after the fact — it falls back to the union of the topics' own affected-file lists, sorted, with no line counts. The header's file count is generated from the summary, so without this fallback the page contradicted itself. |
| `e2e` | Recorded verification scenarios, verbatim. |

Several fields a reader might expect are **deliberately absent rather than invented**: a conversation kind, an immutability flag (regeneration is an in-place update, with no revision history to point a lock at), a minted sequential id (the short hash is already stable and content-bound), per-file add/modify/delete status (only line counts are stored), and tool-call arguments (only counts are stored, so a row reads "×22", never what was read).

**Two fields were deliberately REMOVED from the conversation row, and the deletion is privacy-relevant.** The whole model is serialised into the served document, so a field on that row is a field in the page — which is why the rule is that nothing lands there which the client does not use. A transcript path and a native-title flag briefly rode it to drive a server-side title read, defended by stripping them on the way out: a convention nothing could enforce, shipping an **absolute path under the user's home** into every rendered page for a value the page never displayed. The title is now resolved once at archive time, so there is no private data to carry and nothing to strip. The session identifier survives that same rule for the opposite reason — it is an opaque id the agent chose, not a fact about this machine's filesystem, and it earns its place by being the only thing that distinguishes two rows.

### The context document read

One body, for the viewer that opens a context row. Scoped to a repository but **not** to a commit — the same plan backs several memories, and the caller already knows which row was clicked. The repository token accepts the same name-or-identity forms every other read does. An unknown repository, kind, or key answers *nothing* rather than throwing, so the caller can report a miss without special-casing.

The **skills** kind is the one that is *rendered* rather than read: its per-commit table is not a stored document at all, so it is built from the summary with the same renderer that writes the browsable file (spec 323) — reading the **tree**, matching the detail pane, so the dialog cannot answer with a different skill set than the row's own count line claims. A memory with no skills answers nothing.

### The settings payload

Built entirely from configuration plus one cheap folder-state peek — no database read, no subprocess on the common path — and passed straight through this layer.

- **Agent toggles** are each "not explicitly false", so an unset value means on. `globalInstructions` is the one tri-state: `default` means "never decided" and must round-trip as "leave unset", never as `disabled` (which would instruct a removal of a block that was never written).
- **Only masked keys ever reach the payload** — first up to 12 characters, `****`, last 4; an empty string for an absent key; a key of 16 or fewer characters carrying neither recognised key prefix passes through **unmasked**. The full key stays server-side and is re-read on save. Nothing here decodes a key, which is what keeps this path clear of the clear-text-logging gate.
- The provider resolves as: an explicit stored value wins; otherwise `jolli` when an auth token is on file, else `anthropic`.
- The site label is the **host** of the stored site URL — never derived from the key.
- The memory-bank state line is computed for the **server's launch directory**, not the currently scoped repository, and is omitted entirely when that directory is not a project (no honest verdict to show). All three severities are reported, including the healthy one, whose text names the resolved per-repository folder.
- That state is **memoised on (launch directory, configured folder)** because computing it spawns several git subprocesses; uncached it ran on every settings fetch and, colliding with the page's own poll, could look hung. It is a **single slot**, not a table — a second key simply replaces the first, which costs nothing because one server serves one launch directory. An explicit invalidation exists for the one action that changes which folder the launch repository resolves to *without* changing the configured folder.
- The slow figures — the local-agent availability probe, the per-repository push list, and the missing-summaries count — are deliberately **not** here.

### No model-derived field — this layer calls no model at all

**Nothing in this read model calls a language model.** The standup's insights, the decisions themselves, and every count on every card are derived by query.

That is now unconditional. A single field used to be the exception: the newest decision on the decisions card could carry a one-sentence compressed *gist*, produced by a model call at display time, with a process-lifetime cache keyed on the commit hash **and** a fingerprint of the decision text (a hash-only key served the old gist beside a regenerated decision, permanently), negative caching so a failure did not re-attempt on every poll, a bounded cache with first-in eviction, an output-token and wall-clock cap, and a transport rule that stripped just that one field from a cross-site reader. All of it is gone, along with the trimming of the decisions card that accompanied it: a decision record's text field is now its **title**.

The consequence worth stating is that this layer's cost is now purely query cost. There is no per-request model spend, no cache to warm, no configured-model dependency, and nothing for the transport layer to suppress.

### The payload version is a breaking-change counter

The payload carries a version the browser compares against the one inlined into its own page, reloading on a mismatch instead of re-rendering. It exists for one failure: a tab left open across an upgrade polls this model and tries to render a shape that no longer exists.

It is bumped only for a change that would break such a tab, and each bump names one:

| To | Breaking change |
| --- | --- |
| 2 | The Decisions **view** was retired — its view token and payload shape removed, so an old tab would poll for a view that no longer exists |
| 3 | The scope became a repository **list**; the singular identity field is gone, so a pre-3 tab reads nothing off every reply and silently repaints itself as all-repositories while its address still says otherwise |
| 4 | The Recall **card** was retired and the decisions card trimmed: the recall payload is gone (a pre-4 tab reads a count straight off it and throws — and the activity view is the one view with a polling loop, so it throws again on every tick against the payload it already holds) and a decision record's text field became its title |

The activity view's poll is what makes this load-bearing rather than cosmetic: without the counter, one retired field turns a stale tab into a console error every tick.

### Read failures

Failures degrade the smallest thing that can carry them; nothing here turns a bad row into a failed page.

| Failure | Result |
| --- | --- |
| The memory-feed query throws | The feed degrades to empty and is logged; the page then renders the session list instead. It is one card on one page. |
| One archived transcript blob is unreadable | That conversation is dropped with a warning; the others still render. Counted nowhere — this is a read path, and the import already reports what it skipped. |
| A reference's document key cannot be derived | That row renders as a plain label with no key, rather than failing the whole memory detail. The writer's equivalent throws on an unregistered source, which is correct for a write and wrong for a read. |
| A receipt's stored commit list will not parse | Treated as empty; the call still counts. |
| The launch repository's folder state cannot be computed | The state line and its repository label are omitted; the rest of the settings payload is unaffected. |
| A per-repository reachability computation fails | That repository is recorded with **no** filter rather than dropped, so its rows all render — recording it distinguishes "checked, no filter" from "never checked", which a dropped entry would not. |
| A stored memory payload will not parse | Structurally prevented on the way **in**: three of the memory row's columns are stored projections computed from that JSON at insert time, so the engine rejects a malformed payload rather than storing it. Every read here therefore parses it unguarded — including in the memory feed, where the parse sits *outside* the guard that degrades a failed feed query to empty, so this is the one shape that would fail the whole payload rather than one card. |

## State Transitions

| From | Trigger | To |
| --- | --- | --- |
| Any scope token | Exact identity match | Scope unchanged (already canonical) |
| A display-name token | Exactly one repository carries it | Scope rewritten to that repository's identity |
| A display-name token | Two or more repositories carry it | Scope **left as-is** (warned) → resolves to a key matching nothing |
| A token no repository matches | Any query | A key matching nothing — empty results, never "all repositories" |
| `custom` range | Bounds usable | The clamped custom window; `range` stays `custom` |
| `custom` range | Bounds rejected | The 30-day preset; `range` reports `month`, not `custom` |
| A memory-only dimension | Tier is `installed` | The `model` axis, reported as `model` |
| Tier `installed` | Any memory acquires turns/tokens/ticket, or any topic acquires decision/todo text | Tier `memory`; capture counts and insights change from absent to present |
| A page cursor | Its memory still in the reachable set | The page after it |
| A page cursor | Its memory gone from the reachable set | The **first** page, flagged |

## Notable / Surprising Behavior

- **The tier can never reach its third value.** The tier type admits a `space` level, and the stylesheet keys treatments off a numeric index that includes it, but tier detection only ever answers `installed` or `memory`. Every "space tier" affordance is therefore unreachable at HEAD. (Unreachable.)
- **The standup's insights can only ever be decisions and todos.** They are derived from each memory's topics, and only two kinds of text are derivable there — so the `blocker`, `question` and `gotcha` kinds, which the render order and the board's Risks column exist for, are never produced. At the memory tier that column always reports nothing flagged. (Surprising; unreachable at HEAD.)
- **An insight's addressed-to field is never populated.** Nothing on the derivation path writes it, so any surface rendering an addressee renders nothing. (Unreachable.)
- **The `% cached` KPI divides by input + cached, not by total tokens.** Output is excluded from the denominator, so the figure is the cache's share of *input-side* traffic. (Notable.)
- **Two different clocks decide when a memory happened, and the fallback between them is everywhere.** The commit row's committer date is preferred; the memory's own recorded date (an author date) is the fallback for a memory whose commit row does not exist yet. Filtering or sorting on the raw stored date alone put a rebased commit in a different bucket from the capture count directly above the list it appears in. (Notable; the same fallback appears in the list, the detail and the feed.)
- **The memory feed's page is re-narrowed to (repository, hash) pairs after it is fetched.** Reading the payload rows by hash alone can match a row the page never selected when two repositories in scope share a commit (a fork, a vendored tree). (Surprising.)
- **The activity feed's severity badge is derived from diff size and nothing else.** No stored field says major or minor; the threshold is a constant so the wording and the cut cannot drift apart. (Notable.)
- **A card that cannot be measured says nothing rather than zero.** Turns, cost and ticket on a standup row, the capture and decision counts, and the insight list are all *absent* below the tier that fills them, because a rendered `$0.00 est · 0 turns` is a claim while "not shown" is the truth. (Notable; applies across views.)
- **Two figures on the memories page are counted under different rules.** The memory count is reachability-filtered; the topic and repository vitals beside it are not. On a machine whose branches have been rebased away they disagree by construction. (Surprising.)
- **The estimated recall series is zeroed per day, not globally.** That is what lets one window hold both halves of the history — days before receipts existed keep their estimate, days after are told by the receipts alone. (Notable.)
- **The first-receipt date is the one figure on the recall card that ignores the window**, because a windowed version could only ever report the window's own start. (Notable.)
- **The tool-usage numerator and denominator carry deliberately different window predicates.** The denominator admits a session by *either* clock; the numerator requires a call in the window. Making them the same in either direction produced a fraction that contradicted the table under it. (Surprising; both halves were bugs at one point.)
- **Recall's two pre-receipt channels are max'd, never summed** — each is a lower bound with a hole the other does not have, and they share no key that would let them be joined. (Notable.)
- **The settings folder-state probe is memoised for the life of the process** and needs an explicit invalidation after an action that re-points the launch repository's folder without changing the configured folder. (Notable.)
- **The gist cache stores failures.** An absent gist is indistinguishable to a caller from a suppressed one, and both mean "show the raw text". (Notable; this is the only route in the read model that can spend money.)
- **A custom range is clamped in two directions but rejected outright for three input shapes**, and the payload always echoes the window actually used — a range control that displayed the request instead would misreport what the numbers cover. (Notable.)
- **Nothing in this layer can reach a write.** It issues no statement that could write one, and every handle it is given is opened read-only — but that read-only-ness is enforced by the **connection**, not by the handle's type, which still exposes a general execute. The guarantee is a runtime one. (Notable; load-bearing.)
- **The tier is the one machine-wide figure in a scoped payload.** Every other number on a single-repository page answers for that repository; the tier answers for the machine, and it is what gates whether several cards render at all. (Surprising.)
- **The payload-minimality rule on the conversation row is what removed an absolute home-directory path from every served page.** A transcript path and a native-title flag were on that row to drive a server-side read and were stripped on the way out by convention — which nothing could enforce — so the path shipped into the document for a value the page never rendered. The row now carries only what it renders: title, source, count, and the session identifier that serves as its tooltip. (Notable; the rule's payoff is a deletion, not a field.)
- **A memory with no commit row of its own appears in the feed but not in the count above it.** The capture count requires that row; the feed falls back to the memory's own recorded date. (Surprising; the same fallback that keeps a rebased memory in the right bucket is what splits these two.)

## Shared Behavior

- The route surface, the security layers, the suppression conditions for the model-spending read, and page assembly are owned by spec 352.
- The repository registry file this layer joins against, the identity derivation, the folder probe, and the **unreachable** configuration/hook-status settings assembly are owned by spec 355.
- The write protocol that produces every row read here is owned by spec 354.
- The settings payload's counterpart write — validation, the single configuration transaction, the mask-reuse resolution on save, the all-repositories hook sweep, and the invalidation this layer's folder-state memo depends on — is owned by spec 363.
- The browser application that consumes these payloads is owned by spec 356.
- The skills table and its one-line summary label, rendered into the memory detail's context row and its document, are owned by spec 323.
- Summary-tree assembly, conversation-token aggregation, the whole-tree cost estimate, archived-conversation grouping, reference display rules, and the memory-id format are owned by the summary and reference specs; this layer calls them so the dashboard and the editor describe the same memory the same way.
