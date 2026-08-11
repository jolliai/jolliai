# Local agent concurrency — design

Date: 2026-08-11
Status: approved, ready for an implementation plan

## 1. What this is

A local, self-only answer to one question: **how many agents was I running at
the same time?**

This is the collection half of "Axis 3" from the cloud coaching specs
(`2026-08-05-coaching-data-axes.md`), which record Axis 3 as "Exists: nothing".
That is no longer true — the local SQLite dashboard already collects sessions
from every discovered agent, machine-globally and without the `git push` gate
the cloud specs assume. What is missing is not a channel; it is the *interval*
inside each session.

Nothing here uploads anywhere. Cloud upload is a separate, later decision, and
this design is deliberately shaped so that it cannot drift into one: the figures
are per-machine and self-only, there is no developer identity, nothing is ranked,
and no figure is comparable across people.

## 2. Why the data is not already there

Two measurements on this machine's real
`~/.jolli/jollimemory/jollimemory.db` (1670 sessions):

- **`started_at_ms` is populated on 35 rows — 2.1%.** All 35 are Claude and all
  are dated 2026-08-08 or later (the rest of the table reaches back to
  2026-03-27), because the column is this branch's own recent addition.
- **`duration_ms` is not a working figure.** The longest of those 35 spans
  1088.6 minutes — 18 hours — across 28 messages. It is a session resumed the
  next day. Anything built on `last − first` would claim 18 hours of presence.

The root cause of the first is one line,
[`DashboardCollector.ts:213`](../../../cli/src/dashboard/DashboardCollector.ts):

```ts
if (source !== "claude") return base;
```

The early return exists for **token** reasons — only Claude transcripts carry
per-turn usage — but it also discards `startedAtMs`, `durationMs` and
`messageCount` for every other source, none of which depend on usage data.

`started_at_ms` is otherwise read by nothing: every existing query
(`heatmap`, `hours`, the trend series, `recentSessions`) filters and buckets on
`updated_at_ms` alone, so a three-hour session lands in exactly one hour bucket
today. The schema anticipated this — its own comment says `started_at_ms`
"cannot be recovered from `updated_at_ms` and duration", which is why the column
was kept.

## 3. Decisions

| Decision | Choice | Rejected alternatives |
|---|---|---|
| What the view answers | Concurrency — how many agents at once | Presence-hours; a live "what is running now" list |
| How "at the same time" is defined | 15-minute activity buckets; a session occupies a bucket if it produced a message in it | Interval overlap with a gap threshold (needs a tuning parameter and sweep-line queries); naive `(start, last-activity)` (measurably wrong — see §2) |
| History | Forward collection only | A one-time backfill over the 2196 Claude + 2152 Codex transcripts still on disk (~7 weeks, oldest 2026-06-23). Feasible, deliberately deferred |
| Repo scope | Always machine-global; ignores the page's repo filter | Following the filter (truncates the number into something with no actionable meaning); a global figure plus a per-repo share (invites reading the share as a KPI) |
| Re-read semantics | Insert-only — a bucket is a monotone fact, no read removes one (§4.1) | Wholesale replace like the sibling tables (destroys real presence when a host truncates or Devin regenerates, unrecoverably) |
| Downstream sync cursor | `recorded_at_ms`, the local insert instant (§4.1) | `bucket_ms` (a backfill inserts old buckets today and a cursor on it would skip them); a monotone rowid/seq (a timestamp is also legible to the consumer) |
| Non-Claude token/model | Out of scope this round | Wiring OpenCode's token columns (see §7) |
| UI | None this round — the model field only | A card in the vacated session-activity slot; a split tab on an existing card |

### 3.1 Why buckets rather than intervals

A bucket list needs no threshold parameter, is a single `GROUP BY` to query, and
handles the 18-hour resumed session correctly by construction: that session
occupies only the buckets it actually spoke in, not the 72 buckets it spans.

The cost is that `peak` becomes an **upper bound** on instantaneous concurrency
rather than the thing itself. Two sessions active in the same 15-minute bucket
need not overlap at any instant. §5 makes that explicit in the label; it must not
be simplified away.

## 4. Data model

### 4.1 New table

Appended to `MIGRATIONS` in
[`DashboardDb.ts`](../../../cli/src/dashboard/DashboardDb.ts) as
`SESSION_ACTIVITY_DDL`, entry 7 (the eighth), bumping
`DASHBOARD_SCHEMA_VERSION` from 7 to 8. The slot is what this branch's actual
base yielded — the plan's §"recompute it" warning, honoured — and it is now only
bookkeeping: identity moved to the entry's NAME, so the number decides nothing.
Append-only still holds: existing entries are never edited, because a shipped
entry's DDL is frozen and `MigrationFingerprints.test.ts` fails on a change to
one.

```sql
CREATE TABLE session_activity (
  session_event_id TEXT NOT NULL REFERENCES sessions(event_id) ON DELETE CASCADE,
  bucket_ms        INTEGER NOT NULL,   -- 15-minute bucket start, absolute epoch ms
  recorded_at_ms   INTEGER NOT NULL,   -- when this row was first inserted locally
  PRIMARY KEY (session_event_id, bucket_ms)
) STRICT;
CREATE INDEX ix_activity_bucket ON session_activity(bucket_ms);
CREATE INDEX ix_activity_recorded ON session_activity(recorded_at_ms);
```

`recorded_at_ms` is `NOT NULL` because it ships inside the `CREATE TABLE` rather
than arriving as a later `ADD COLUMN`, which takes only a CONSTANT default while
this value is a wall-clock instant. That is entry 4's `last_call_at_ms` shape,
whose permanent `NULLIF` handling at every read site is the price of having had
no choice.

A dev machine that ran an earlier draft of this entry has the table under the
same name, so the name key reads it as applied rather than replaying it. A
differing shape is then **drift**, not a missing table: `findDriftedMigrations`
reports it and `jolli doctor --schema-log` lists it, and the repair is the
operator's.

#### The table is INSERT-ONLY

`projectSession` replaces `session_model_usage` and `session_tool_use` wholesale
on every observed read; this table deliberately does not follow that contract.
Those two restate a **current total**, so a new read supersedes the old. A bucket
is a **monotone historical fact** — "this session produced a message in this
quarter-hour" cannot become false — so no read may remove one.

Every case where a re-read returns a non-superset is the evidence going away, not
the fact: a host rotating its own store, or Devin regenerating onto a different
`main_chain_id` so the walked chain differs. Wholesale replace destroyed real
presence there, unrecoverably, because the transcript could no longer prove it.

The cost is the mirror image and is recoverable: a bucket from a **bad read** (a
parser reading Devin's epoch seconds as ms, a local-time string parsed as UTC)
now persists rather than being corrected by the next re-read. No repair path
ships with this — the failure needs a parser bug first, and a wrong row can be
rebuilt where a deleted one cannot be recovered at all.

`ON DELETE CASCADE` stays. Nothing deletes from `sessions` today; insert-only is
a rule about re-observation, not about referential cleanup.

#### `recorded_at_ms` is a sync cursor

The instant of first local INSERT — deliberately nothing about the conversation.
`bucket_ms` cannot serve as a cursor: a backfill over old transcripts inserts old
buckets today, and a `bucket_ms > lastSync` reader would skip all of them. This
column answers only "what is new since my last upload", which is the one question
a downstream sync must ask without knowing what a bucket means.

`INSERT OR IGNORE` keeps a re-observed bucket's **original** stamp, so a 60 s tick
does not re-present a whole session as new work. Two consumer caveats: the clock
is `Date.now()` and not monotonic across an NTP correction, so pair the cursor
with an idempotent upstream upsert and resume at `>= lastSync` (which also
absorbs the same-millisecond boundary); and it is a local stamp, so two machines
belonging to one developer stamp independently.

`bucket_ms` holds **absolute epoch ms**, not a localised day/hour key. Time zone
is a render-time concern that `localDayKey` / `localHour` already handle in the
query layer; a stored localised copy would be a second answer to a question that
already has one.

`INTEGER` is the type every epoch-ms column in this schema already uses, and it
was verified rather than assumed: `node:sqlite` returns these as JS `number`
(no `readBigInts` anywhere in the repo), current values sit ~5042x below
`Number.MAX_SAFE_INTEGER`, and a round-trip through a STRICT table is exact.
STRICT additionally **rejects a REAL value** in this column, so a missing
`Math.floor` in the bucketing helper fails loudly at insert instead of silently
storing `…300000.5` and defeating the primary key.

Size: bucket count per session is bounded by its message count, and the whole
database sums to 8834 messages — a few thousand rows, smaller than `commits`.

### 4.2 Event field

On `SessionUpsertedEvent` in
[`DashboardModel.ts`](../../../cli/src/dashboard/DashboardModel.ts):

```ts
/** 15-minute bucket starts, deduped and ascending. ABSENT means this source's
 *  reader emits no per-message timestamps, and the stored rows are left alone.
 *  NEVER `[]` — see below. Same contract as `tools`. */
readonly activityBuckets?: ReadonlyArray<number>;
```

The ban on `[]` is load-bearing. A source that never stamps timestamps computes
an empty array on every read; emitting it would assert "measured, no activity"
for a source that was never measurable. This is the failure mode
`TranscriptReadResult.toolUse`'s own contract exists to prevent. Emitting the
field only when `length > 0` makes "uncovered" and "genuinely idle"
structurally impossible to confuse.

### 4.3 Collection

The early return moves so that every source reads its transcript; only the
token/model block stays gated on Claude.

Simply deleting the early return is wrong. `sessionEventFromInfo` currently calls
`readUsage(s.transcriptPath)` with **no parser argument**, which defaults to
`new ClaudeTranscriptParser()` — letting a Codex transcript through that path
yields zero entries, a silent empty result rather than an error. The correct
read is the existing 13-way dispatcher `readUnreadTranscript` in
[`TranscriptMessageCounter.ts:122`](../../../cli/src/core/TranscriptMessageCounter.ts),
which is currently module-private and must be extracted and exported (named
`readTranscriptForSource` below), called with a **null cursor** for a full read:

```ts
const read = await readTranscriptForSource(source, s.transcriptPath, null);
const buckets = bucketsFrom(read.entries);   // floor(ts / 900_000) * 900_000, deduped
return {
    ...base,
    messageCount: read.entries.length,
    ...(buckets.length > 0 ? { activityBuckets: buckets } : {}),
    ...(source === "claude" ? { models, tokenCoverage, pricesAsOf } : {}),
};
```

No declared list of supporting sources is introduced. Capability is inferred
from whether a read produced buckets, because the declarative alternative is
exactly the shape of `PARSER_BACKED_SOURCES`, which today omits `kimi` even
though `getParserForSource` accepts it — making `TOOL_RECORDING_SOURCES`
permanently unable to include kimi. The six sources that emit no timestamps are
read anyway; they account for 60 sessions in total, so a list maintained to save
that is more expensive than the reads it avoids.

### 4.4 Persistence

In `StatsWriter`, mirroring the `session_tool_use` block:

```ts
if (event.activityBuckets !== undefined) {
    db.prepare("DELETE FROM session_activity WHERE session_event_id = ?").run(eventId);
    // then INSERT each bucket
}
```

Delete-and-replace is safe **because the collector does a full read**, not a
cursor-bounded slice. A slice-based producer would need a merge instead.

### 4.5 Coverage this buys

Measured on the real database:

| Sources | Sessions | Reader emits `TranscriptEntry.timestamp` today |
|---|---|---|
| claude | 1199 | yes |
| codex | 376 | yes |
| copilot, copilot-chat, antigravity, gemini | 35 | yes |
| opencode | 34 | yes — [`OpenCodeTranscriptReader.ts:254`](../../../cli/src/core/OpenCodeTranscriptReader.ts) derives `time_created` per message |
| cursor | 14 | yes — [`CursorTranscriptReader.ts:126`](../../../cli/src/core/CursorTranscriptReader.ts) reads `bubble.createdAt` per message |
| **covered** | **1658 / 1670 = 99.3%** | |
| cline-cli, devin, cline | 12 = 0.7% | no |

No reader work is therefore in scope: the eight sources that already emit
timestamps cover 99.3% of sessions.

(An earlier version of this table put `opencode` and `cursor` on the
uncovered side; both readers already stamp a per-message timestamp, and a
real-data probe produced buckets for both — 2/2 opencode sessions, 11
buckets; 1/1 cursor session, 1 bucket — alongside claude and antigravity.
This was harmless by construction: `measuredSources`/`uncoveredSources` in
§5 are derived from the data per query rather than from a declared list, so
a declared list built off this wrong table would have permanently excluded
both sources — the per-query derivation is what contained the mistake.)

Note for §7: the uncovered three are uncovered because *our readers drop the
data*, not because the data is absent. Devin's `message_nodes.created_at` is
populated on every row inspected.
"Unavailable" here means "not read yet", which is a different claim from
"unreadable".

## 5. Query

`buildConcurrency(db, opts)` in
[`DashboardQuery.ts`](../../../cli/src/dashboard/DashboardQuery.ts).

```sql
SELECT a.bucket_ms,
       COUNT(DISTINCT s.source || ':' || s.session_id) AS n
  FROM session_activity a
  JOIN sessions s ON s.event_id = a.session_event_id
 WHERE a.bucket_ms >= ? AND a.bucket_ms < ?
 GROUP BY a.bucket_ms
```

**`COUNT(DISTINCT session_event_id)` would be wrong.** `sessions` is unique on
`(repo_id, source, session_id)`, so one agent session that touched two repos is
two rows with two event ids — measured: three such groups exist for `cursor` on
this machine. Counting event ids reports one agent as two. This interacts
directly with the machine-global scope decision: under a per-repo filter the bug
would be latent, and the decision to aggregate across repos makes it certain.

```ts
export interface ConcurrencyModel {
    readonly buckets: ReadonlyArray<{ bucketMs: number; sessions: number }>;  // n > 0 only
    readonly peak: number;
    readonly meanActive: number;
    readonly measuredSources: ReadonlyArray<TranscriptSource>;
    readonly uncoveredSources: ReadonlyArray<TranscriptSource>;
}
```

Carried as an optional `StatsModel.concurrency?`, so an older asset bundle
served by a newer server ignores it rather than failing.

Three semantics that must reach whatever eventually renders this:

1. **`peak` is an upper bound.** Its label must say "agents active within the
   same 15 minutes", never "running simultaneously" (§3.1).
2. **`meanActive`'s denominator is active buckets, not window buckets.** A
   7-day window holds 672 buckets; dividing by all of them yields ~0.2, a
   figure with no meaning. Dividing by the buckets with activity answers "when
   I am working, how many agents do I typically run". The denominator must be
   stated wherever the number is.
3. **`measuredSources` / `uncoveredSources` are derived per query**, not
   declared: measured = contributed ≥1 bucket in the window; uncovered =
   contributed sessions but no buckets. Same shape as `buildToolUsage`'s
   existing `uncoveredSources`, for the reason in §4.3.

**Empty window: the whole `concurrency` field is omitted**, so a consumer shows
"no data" rather than a zero. Under forward-only collection this is the normal
state for the first days after deployment, not an edge case.

## 6. Scope, testing, failure modes

Delivered: the migration, the collector change, the writer branch, the query,
and `StatsModel.concurrency?`. **No UI.** The stats page's session-activity card
(heatmap, hour histogram, records) was deliberately removed while its payload
stayed live — `stats.heatmap` / `stats.hours` / `stats.fun` are in the model and
rendered by nothing, with a comment stating that restoring the card is a render
change only. Concurrency enters that same state deliberately: the card order is
authored against jolli-design's Dashboard route, which is not available here, so
placing a card is not a call this design makes. The follow-up is then pure
front-end with no server change.

Tests, one per deliberate choice above:

| Case | What it prevents |
|---|---|
| `bucketsFrom`: floor, dedupe, ascending | A missing floor throws at insert (STRICT), but a missing dedupe silently inflates the table |
| No timestamps → field absent, not `[]` | Conflating "uncovered" with "idle" (§4.2) |
| Writer leaves rows alone on `undefined` | Re-upsert from a timestamp-less producer erasing a good read |
| Cross-repo session counted once | The `source:session_id` key of §5 |
| `meanActive` denominator | The ~0.2 figure |
| `measured` / `uncovered` derived from data | The `PARSER_BACKED_SOURCES` omission shape |
| Empty window omits the field | The first days after deployment |

Failure modes: below the Node 22.13 `node:sqlite` floor, `ProducerHooks`'
existing contract already skips the write and never blocks git — the new table
does not change that, and a skipped write degrades to `uncovered`, which is the
honest label. The migration is append-only.

Coverage floor stays 97/96/97/97.

One-time cost: bootstrap read volume roughly doubles. It reads Claude's 0.8 GB
today and will additionally read Codex's 0.8 GB. Steady state is unaffected —
the StopHook and the VS Code 60-second tick each touch one session.

## 7. Deliberately out of scope

- **Cloud upload.** A separate decision. Nothing here is uploadable as designed:
  no developer identity exists in the local database, and sessions are
  implicitly "this machine's user".
- **Backfill.** The transcripts are on disk (2196 Claude + 2152 Codex, oldest
  2026-06-23) and the existing `Backfill.ts` is a natural host, so this stays
  cheap to add later.
- **Non-Claude token/model.** OpenCode's `session` table carries `model` (329 of
  349 rows), `tokens_input` / `tokens_output` (328), `tokens_cache_read` (230)
  and `tokens_reasoning` (289). Three findings for whoever picks this up:
  `model` is a JSON blob (`{"id","providerID","variant"}`) whose ids include
  values absent from `Pricing.ts` (`big-pickle`, `deepseek-v4-flash-free`), so
  they belong in the existing unpriced-model set; `cost` is 0 on all 349 rows
  and must not be read; and `tokens_cache_read` reaches 20.4M on a session whose
  input is 1.75M, the same cumulative-counter shape that made this repo exclude
  Claude's `cache_read_input_tokens` from `ConversationTokenBreakdown` — the
  matching column is `tokens_cache_write`, which is 0 everywhere.
- **Reader work for the uncovered three (`cline-cli`, `devin`, `cline`).** Worth
  doing only if the 0.7% matters or a specific user's mix is dominated by one
  of them.
- **`PARSER_BACKED_SOURCES` omitting `kimi`.** A pre-existing latent bug found
  while writing this, unrelated to concurrency. It should be fixed on its own.
