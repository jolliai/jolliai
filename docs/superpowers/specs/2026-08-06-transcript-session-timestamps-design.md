# Transcript session timestamps on the pushed summary — design

**Date:** 2026-08-06
**Project:** Manager coaching dashboard (JOLLI-2123 … JOLLI-2127) — this repo's half
**Status:** draft
**Scope:** Emit a root-stamped, tree-wide `transcriptSessions[]` array on the pushed `summaryJson`,
carrying `{sessionId, source, messageCount, startedAt, endedAt}` per conversation. Push-time
enrichment only — nothing is added to the stored summary schema. This is the *only* deliverable here;
see [§7](#7-deliberately-out-of-scope) for what was considered and deferred, and why.

The server side of this project lives in the `jolli` repo and is described by three specs there:
`2026-08-04-manager-coaching-dashboard-design.md` (what the page shows),
`2026-08-05-coaching-data-axes.md` (where each signal legitimately comes from), and
`2026-08-06-axis2-review-index-design.md` (the review index). Those documents are authoritative for
consumer behaviour; this one is authoritative for what this repo emits.

## 1. Why this, and why it is the whole delivery

The dashboard's server side is built: `journey_commit_index`, the indexer, assembly, the query API
and the Axis 2 review index all exist. What it renders is gated on data this repo has never sent.

`durationMinutes` is the time axis every glyph, the trace total, the feed's hour figures and
`isFeatureWork`'s 45-minute threshold are drawn against — and it has **no source at all** today. The
server's `JolliMemoryTranscriptSessionSchema` already carries optional `startedAt` / `endedAt`, and its
own comment names the missing producer: *"push-time enrichment; see the plugin's
`collectTranscriptSessionMeta`"*. That function does not exist here. Neither does the field it would
populate: `CommitSummary` carries only `transcripts?: string[]`.

Establishing that by reading the tree rather than assuming it:

| Signal the dashboard wants | State in this repo |
|---|---|
| `transcriptSessions[]` with per-session bounds | **Absent.** No such field, no producer. |
| Per-commit turn-level `skills` | **Already emitted.** `CommitSummary.skills` rides in `summaryJson` today; the server does not yet model or index it. Nothing to do here. |
| `prNumber` (Axis 2 join key) | Absent — deferred, see §7. |
| Session intervals decoupled from commits (Axis 3) | Absent — blocked on a product decision in the axes spec. |

So the one unblocked, unowned, high-leverage gap on this side is the session time axis. Without it
`isFeatureWork` returns false for everything and the patterns miner mines nothing, which is what the
08-04 design already records as *"encoded and tested, not hoped for."*

## 2. Decision: derive at push time, never store

| # | Decision | Rationale |
|---|---|---|
| D1 | The enrichment is computed **at push time** from the transcript artifacts, not stored on `CommitSummary`. | Two reasons, and the second is the load-bearing one. It keeps the change clear of the stored-schema lockstep contracts (FolderStorage's hidden layer, the IntelliJ Kotlin readers, the orphan-branch layout). And it is **retroactive**: every already-stored memory gains its time axis on its next push, where a write-time field could only ever cover new commits. |
| D2 | The field is **not added to `CommitSummary`**. The push layer defines `CommitSummary & { transcriptSessions?: … }` and only the markdown builder and `serializeSummaryJson` accept it. | Makes "push-only, never persisted" a fact the type system enforces rather than a comment. The storage path cannot name the field, so it cannot write it. |
| D3 | One array, **stamped on the root only**, aggregated across the root and every `children` node. | The server's `mergeSessionStats` documents `transcriptSessions` as *"a push-time, tree-wide enrichment stamped on the root"* and merges duplicate rows **keep-first, never summed**. A per-node stamp would therefore have the server silently truncate `messageCount` and the time bounds for any session appearing on more than one squash child. |
| D4 | Per session, aggregate: `messageCount` sums, `startedAt` is the min and `endedAt` the max across **all** of that session's transcript slices. | Matches the field's own contract (*"archived message count across all of the session's transcript slices"*). One session legitimately spans several artifacts — an amend delta plus its base — so keep-first on our side would under-report both the count and the span. |
| D5 | The reader is **injected** (`StorageProvider` / a transcript-reader seam), never reached for directly. | Keeps the new module's tests in the `test:fast` tier. Real-`git` test files are the ones that CPU-starve and time out under a full `--coverage` run, and a timeout is indistinguishable at a glance from a real regression. |

Rejected: computing it in `QueueWorker` at summary-write time. It touches the stored schema (so
FolderStorage and the Kotlin readers must move in lockstep), it cannot be backfilled, and a new
stored field has to be landed across the seven git-op paths — amend, squash, the three rebase
variants — where a missed folding path fails silently.

Also rejected: doing both and letting push-time derivation act as a fallback. Two sources for one
number drift.

## 3. What is emitted

One array on the root of the pushed `summaryJson`:

```ts
readonly transcriptSessions?: ReadonlyArray<{
	readonly sessionId: string;
	readonly source: string;        // StoredSession.source; absent means "claude" per the existing convention
	readonly messageCount: number;  // summed across every slice of this session
	readonly startedAt?: string;    // min parseable entry timestamp
	readonly endedAt?: string;      // max parseable entry timestamp
}>;
```

Derivation, per session key `<source>:<sessionId>`, over the root's and every child's
`transcripts[]` artifact ids (de-duplicated — squash children repeat ids):

- `messageCount` — sum of `entries.length` across the session's slices.
- `startedAt` / `endedAt` — min / max of the session's `TranscriptEntry.timestamp` values, counting a
  value as usable only when `Date.parse` returns a number. An unparseable timestamp is ignored, not
  coerced.

### 3.1 Three absence rules, each a different lie avoided

`TranscriptEntry.timestamp` is optional, artifacts can be detached, and a commit can have no
conversation at all. Each case renders as absence, never as a zero:

1. **A session with no parseable timestamp emits neither bound** — not an epoch, not an empty string.
   A journey of unknown length must never render as an instant one; the 08-04 design's availability
   rules exist precisely for this.
2. **An empty result omits the field entirely** rather than sending `transcriptSessions: []`. An empty
   array reads as *"measured: zero conversations"*, and it would also disable the server's fallback
   path for bare transcript ids.
3. **An unreadable artifact is skipped, not fatal.** Its sessions are absent; the rest still emit and
   the push proceeds. A detached or pruned artifact must not block a push.

### 3.2 The size guard must not become a regression

`serializeSummaryJson` drops the **entire** `summaryJson` above 1.5 MB, because the server caps the
field at 2,000,000 characters as schema validation — over it, the whole request 400s and the markdown
article fails with it. The sidecar is optional; the article is not.

A session row is roughly 150 bytes, so a five-session commit adds ~750 B and a thirty-session squash
tree ~4.5 KB — 0.3 % of the cap. The tail case is nonetheless real: a summary already sitting at
1.499 MB would lose its whole sidecar to the enrichment. So **on exceeding the cap, retry once
without the enrichment before giving up.** This is a no-regression guarantee, not a feature: the worst
case becomes today's behaviour rather than worse than it.

(Note in passing: the client measures UTF-8 **bytes** while the server counts UTF-16 **code units**.
Byte count is always ≥ character count, so the client guard is conservative in the safe direction.
Do not "fix" it into a character count.)

## 4. Where it attaches

**Two** weave points. One is `pushSummary` in `cli/src/core/JolliMemoryPushOrchestrator.ts`, async
with a `PushContext` in hand.

The other is `vscode/src/services/JolliPushOrchestrator.ts`. The VS Code extension does not reuse the
CLI's orchestrator: it has its own, with its own `serializeSummaryJson` and its own summary weave,
reached from the sidebar's share action. Omitting it would have been worse than a missing field:
re-sharing a branch re-pushes the same `jolliDocId` with a sidecar lacking the enrichment, and the
server re-derives the duration as null, so data already delivered would silently disappear. Both
halves of the CLI change are mirrored there (the weave and the size-cap retry); the two
`serializeSummaryJson` copies stay separate.

**The count moved twice, for two different reasons.** This document first said "two", having counted
only the CLI and missed the extension — that was an error, and finding it is why the VS Code half
exists. It then said "three": `pushSummary` plus `buildOneBatchItem`, the batch path, plus VS Code.
It is back to two because the batch path was **deleted**, not because it was never woven: this branch
was rebased onto main's *"Replace batch push with per-commit async push orchestration"*, which removed
`buildOneBatchItem` and `buildBatchItems` outright. The weave point went with its host function, and
`pushSummary` — reached from `PushExecutor`'s per-commit path — is now the only CLI push path.
Nothing about the enrichment itself changed, but a reader hunting for "the batch path, which is what
the pre-push hook actually runs" will not find it.

Both build a `summaryForMarkdown` copy and hand it to `serializeSummaryJson`. The enrichment is woven
into that copy in both places. **Both need a test**: they are two independent blocks of weaving code.

New module: `cli/src/core/TranscriptSessionMeta.ts`, exporting `collectTranscriptSessionMeta`. A
per-run `Map<transcriptId, StoredTranscript>` cache avoids re-reading the artifacts a squash tree
references repeatedly.

The derivation does not sit on git's blocking path. Since the same rebase, the pre-push hook pushes
nothing on its own time: it spawns a detached worker and watches the result file for as long as
`PRE_PUSH_SYNC_BUDGET_MS = 3_000` allows, and the worker runs to completion whether or not the watch
is still there. So the artifact reads cost the worker, not the commit. (`INLINE_MIN_HTTP_BUDGET_MS`
went with the batch path.) Measured cost of the reads themselves: **~115 ms per summary**, dominated
by the single orphan-branch `git` invocation and near-flat in the number of transcript ids — worth
knowing before anything moves this derivation back onto a blocking path. No network call may be added
here regardless (see §7).

## 5. Invariants and their tests

| # | Invariant | What it stops |
|---|---|---|
| 1 | A session spanning two artifacts sums its `messageCount` and spans min→max | Keep-first here would under-report, and the server would not complain |
| 2 | `children` nodes carry no `transcriptSessions` | A child copy activates the server's keep-first merge and silently truncates |
| 3 | No parseable timestamp ⇒ both bound keys absent | An epoch or empty string would render unknown duration as an instant |
| 4 | Empty result ⇒ the key is absent from the serialized JSON | `[]` reads as a measurement of zero and kills the bare-id fallback |
| 5 | One unreadable artifact ⇒ others still emit, push does not throw | A pruned artifact must not block a push |
| 6 | Over the size cap ⇒ the un-enriched JSON is serialized | No-regression guarantee |
| 7 | Both `pushSummary` (CLI) and the VS Code orchestrator weave it | Two independent weaving blocks; missing the VS Code one lets a sidebar re-share overwrite delivered bounds with nulls |
| 8 | The stored summary written by the storage path carries no such field | Proves the push-only boundary behaviourally, not by comment |
| 9 | Sum of per-session `messageCount` equals the total `entries.length` over the tree's artifacts de-duplicated by transcript id | Keeps this figure and the server's `ConversationStats.messageCount` from disagreeing |

Tests stay in the fast tier by construction (D5): pure derivation over injected reads, no `git`
subprocess.

**Gate:** one `npm run all` at the end. The CLI coverage floor (97 / 96 / 97 / 97) is not to be
lowered and `cli/vite.config.ts` is not to be touched.

## 6. Not touched

Stated explicitly so the implementation does not drift into them: `CommitSummary`, `FolderStorage`,
the IntelliJ `FolderStorageReader` / `KBFolderReader`, the orphan-branch layout, the queue worker, any
git hook, and the config schema. No new configuration option, no new user-facing surface.

## 6a. Known limitations of what shipped

Found by review after implementation, recorded rather than silently carried.

**The duration measures a span, not activity — and idle time is inside it.** `startedAt`/`endedAt` are
the first and last archived message of a session, so a session opened at 09:00 and resumed at 17:00
reports 480 minutes. The server sums those spans, and can only see gaps *between* sessions, so it
cannot subtract the idle stretch. The practical consequence is that a resumed session clears
`isFeatureWork`'s 45-minute threshold on idle alone and inflates the feed's hour figures. This follows
directly from D4, which was chosen deliberately; nothing here bounds it. **Converging it means
switching from span to active time** — ignoring inter-message gaps above a threshold — which is a
product decision about what a "duration" should mean on this page, not a defect to patch.

Three smaller ones:

- **The push-only boundary is structural, not type-enforced.** Both write-backs build from the raw
  summary, so the enrichment cannot currently reach storage — but §2's D2 overstates the guarantee: a
  spread into a `CommitSummary` would type-check fine, since excess-property checking does not apply to
  spreads. The code is right; the claim was too strong.
- **§5's invariant 9 is not literally true.** A session with an empty `sessionId` is skipped, yet its
  entries do count toward a tree's raw entry total. Harmless, because the server's own merge skips
  keyless rows identically.
- **The enrichment counts toward the batch size limits.** It contributes to
  `BATCH_MAX_TOTAL_CONTENT_CHARS`, so an item sitting just under the limit can now be deferred to the
  background drain instead of publishing inline. Graceful, but it is a behaviour change §3.2 does not
  mention.

One wording correction: §4's per-run `Map<transcriptId, StoredTranscript>` cache is implemented as a
per-call de-duplicated id set. The set covers the case the cache was described for (a squash tree
referencing one artifact repeatedly); a cache spanning summaries would serve no case that arises.

## 7. Deliberately out of scope

**`prNumber` on the summary (Axis 2's join key).** Considered and deferred, because the acquisition
moment does not exist. A branch's PR is created *after* its first push, so at pre-push time there is
no number to read — and post-commit is strictly earlier, not later. Full coverage would require
re-pushing already-published summaries once the PR appears, and the machinery for that (a `gh` poll,
a cache, a backfill trigger) is the same machinery the review-timeline reporter needs. Measured cost
of the poll: `gh pr list` takes **1.07–1.23 s**, which is 36–41 % of the entire 3 s inline pre-push
budget, so it can never sit on that path. Deferred to be built once, with the review reporter.

Meanwhile the server joins review events by `ticket` and reports `availability.reviewTiming` as
`"partial"`. Per the Axis 2 spec's own rule — *when the attribution is approximate, the number must
not claim to be exact* — that is a correct label, not a defect.

**Reporting the PR review timeline (Axis 2's client half).** Blocked, and the blocker is on the
server: `POST /api/coaching/reviews` is mounted on the browser-session auth chain
(`authEmailHandler` → `authRefreshHandler` → provisioning → user context), while this client
authenticates with a `sk-jol-` API key against `apiKeyMiddleware` on `/api/push`. The key cannot open
that endpoint. The Axis 2 spec anticipated the possibility (*"only if the CLI's auth subject proves
identical to the dashboard reader's; they are expected to differ"*) but the mount landed on the read
chain. **This needs a server-side change before any client work starts, and it needs an owner.**

**Session intervals decoupled from commits (Axis 3 presence).** Blocked on the product decision the
axes spec escalates: it would be the first per-person metric on a page whose spine is *no composite
score, no ranking of people*.

**Turn-level friction signals** (`redShare`, compaction points, tests-first). These need transcript
extraction work that no issue owns. Note that the highest-confidence member of that family —
skill/MCP invocations — is **already emitted** and awaits server-side modelling, not client work.
