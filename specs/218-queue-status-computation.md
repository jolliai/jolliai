# 218. Queue-Status Computation

## Topic Statement

A single non-blocking read that composes three independently-sampled signals — the count of pending summary-producing work, the count of pending topic-KB (wiki/graph) ingest work, and the background summary worker's busy state — into one boolean "drained" verdict about whether memory-summary generation is still in progress for a worktree, plus a bounded poll loop that waits for that verdict to flip. The verdict deliberately excludes wiki/graph ingest work so a caller waiting to build a PR never blocks on Memory Bank wiki/graph rendering — and that exclusion is now **automatic on both axes**: ingest work lands in its own by-kind bucket, and ingest runs under its own separate lock (see spec 259) so the summary-drain lock this read consults is never held during ingest.

## Scope

**In scope:**

- The status read: the three signals it samples, that they are sampled concurrently, and how the returned status fields are derived from them.
- The exact meaning of each returned status field and which are load-bearing for the verdict versus purely informational.
- The by-kind active-entry counter: how it walks pending work, the staleness rule it applies, how it buckets non-stale work into summary versus ingest, and how it treats unreadable entries.
- The wiki/graph exclusion, expressed on both axes: via the by-kind split (ingest entries land in the ingest bucket, not the active bucket) and — now automatically — via the worker-busy read (the summary-drain lock this read consults is never held during ingest, so ingest can never make the worker report "busy").
- The worker-busy read: a single atomic read of the summary-drain lock's freshness, reported as a self-consistent `{ held, blocking }` pair where `blocking` simply equals `held`.
- The bounded wait loop: its exit conditions, its non-overshoot sleep, its defaults, and its input hardening.
- The data contract of the status object and of the wait result.

**Boundaries:**

- The on-disk layout of the pending-work queue, the format of an individual queue entry, and the drain loop that actually processes entries are owned by the **git-operation queue worker** spec (34) and the **queue-entry-format** spec (35). This spec is a read layered on top of that queue; it never mutates it.
- The summary-drain lock's identity, staleness threshold, acquisition, ownership-checked release, and heartbeat are owned by the worker/lock specs (34). This spec only *reads* the lock's held/stale state. The **separate** per-worktree ingest lock (spec 259) is not consulted by this read at all — that is precisely why ingest work never trips the worker-busy axis.
- The CLI command that reports or blocks on this verdict is owned by spec 240; the programmatic (MCP) tool that wraps the same two entry points is owned by spec 148. This spec owns the computation both of those surfaces call.
- The topic-KB ingest pipeline (what an ingest entry causes the worker to render) is out of scope; this spec only needs to *recognize and exclude* ingest work.

## Data Contracts

### The three sampled signals

The status read samples three signals **concurrently** (a slow filesystem stat on one must not serialize the others):

1. **Active entries by kind** — a single walk of the pending-work queue that returns two counts: non-stale entries that will produce a memory summary, and non-stale entries that are topic-KB ingest (wiki/graph) work. (See "By-kind active-entry counter" below.)
2. **Stale entry count** — the number of pending entries old enough to be considered abandoned. Informational only.
3. **Worker busy state** — a two-field record `{ held, blocking }` describing the background summary-drain worker, where `blocking` equals `held` (see "Worker-busy read" below).

### Status object

The read returns an object with these fields:

| Field | Type | Meaning | Role |
| --- | --- | --- | --- |
| active count | integer ≥ 0 | Non-stale, non-ingest pending entries (summary-producing work still queued). | **Load-bearing** for the verdict. |
| ingest-active count | integer ≥ 0 | Non-stale ingest (wiki/graph) pending entries. | Informational. |
| worker-busy | boolean | The summary-drain lock is held — i.e. a summary is in flight. | Informational. |
| worker-blocking | boolean | Equal to worker-busy. The summary-drain lock is held only during summary generation (ingest runs under its own separate lock — spec 259), so "held" already means "a summary is in flight"; no phase distinction is needed. | **Load-bearing** for the verdict. |
| drained | boolean | `active count == 0` **and** `worker-blocking == false`. | The verdict. |
| stale count | integer ≥ 0 | Pending entries old enough to be abandoned. | Informational. |

**The verdict depends only on two axes:** no summary-producing entries are queued, and no summary is currently being written. Ingest count, worker-busy (which equals worker-blocking), and stale count never independently change `drained`.

### Wait result

The wait loop returns the same status object plus one added field:

| Field | Type | Meaning |
| --- | --- | --- |
| waited (ms) | integer ≥ 0 | Wall-clock milliseconds the loop spent before returning (drained early, or timed out). |

### Wait defaults

- Default overall timeout: **120 seconds**.
- Default poll interval: **1 second**.

### Staleness threshold (consumed, not owned)

An entry is "stale" when its recorded creation instant is older than the queue's stale age (seven days; owned by specs 34/35). This spec applies that same threshold in its by-kind and stale counters.

### Worker lock timeout (consumed, not owned)

The summary-drain lock carries a freshness window equal to its staleness timeout (five minutes; owned by spec 34). This spec reads only "is the lock fresh?" against that window. It does **not** read any ingest lock or any worker-phase marker — the ingest lock (spec 259) is a distinct file this read never touches.

## Behavior

### By-kind active-entry counter

A single pass over the pending-work queue, producing `{ summary, ingest }` counts:

1. Enumerate the pending entries. If the queue does not yet exist, both counts are zero.
2. For each entry, read and parse it, then compute its age from its recorded creation instant.
3. **Count it as active unless it is *provably* stale** — i.e. include it whenever `age > staleThreshold` is *not* true. This is deliberately the negation of "provably stale," so an entry whose creation instant is missing or unparseable (age computes to a non-comparable value, making `age > threshold` false) is counted as active rather than silently dropped. A genuinely pending summary must be waited on, not omitted; the wait loop's own timeout bounds the downside of a stuck entry.
4. For each counted entry, bucket it: ingest (topic-KB wiki/graph) work increments the ingest count; every other operation kind increments the summary count. The ingest-versus-everything-else split is by the entry's declared operation kind.
5. An entry that cannot be read or parsed counts toward **neither** bucket (it is neither a known-active summary nor a known-active ingest).

**Single scan, not two:** the two counts come from one directory walk, so they stay mutually consistent. Deriving one count as "total minus the other" from two independent scans could skew if an entry is enqueued between the scans.

Note the deliberate asymmetry with the informational stale counter: the stale counter treats an unreadable entry as **stale** (it should be cleaned up), whereas the by-kind counter treats an unreadable entry as **neither active nor stale**. The two counters answer different questions.

### Worker-busy read

The `{ held, blocking }` record is a single atomic read of the summary-drain lock's freshness:

1. Determine `held`: the summary-drain lock exists and its last-modified instant is within the lock-timeout freshness window. A missing lock ⇒ `held = false`. A lock older than the window ⇒ `held = false` (a crashed worker's stale lock does not count as busy).
2. Return `{ held, blocking: held }` — `blocking` is defined to equal `held`.

**Why `blocking` simply equals `held` now:** the summary-drain lock is held only during summary generation. Topic-KB ingest was split out to run under its own separate lock (spec 259), so there is no longer any "phase" a held summary-drain lock could be in other than "a summary is in flight." The read no longer consults any phase marker, and because `held` and `blocking` are derived from one lock read they are trivially self-consistent — the impossible pair `held = false, blocking = true` cannot arise.

### Status read (composition)

1. Sample the three signals concurrently.
2. `active = summary count`; `ingest-active = ingest count`.
3. `worker-busy = held`; `worker-blocking = blocking`.
4. `drained = (active == 0) and (not worker-blocking)`.
5. `stale = stale count`.
6. Return the assembled status object. The read never blocks and never mutates the queue.

### Bounded wait loop

Given an optional timeout and poll interval:

1. **Harden inputs at a single choke point** (both the CLI and the programmatic caller flow through here): a timeout that is not a finite, non-negative number is replaced by the default timeout; a poll interval that is not a finite, strictly-positive number is replaced by the default poll interval. This guards against a caller (e.g. a client that bypassed compile-time typing and sent a non-numeric timeout) producing a non-comparable value — which would make the "elapsed ≥ timeout" test never true and a zero/non-numeric sleep fire immediately, spinning the loop hot forever. A nullish-only fallback is insufficient because a non-numeric-but-non-null value is not nullish.
2. Record the start instant.
3. Loop:
   a. Take a status read.
   b. Compute elapsed = now − start.
   c. If the status is `drained` **or** elapsed ≥ timeout, return the status with the elapsed value attached. (Drained wins the tie: it is checked first.)
   d. Otherwise sleep for `min(pollInterval, max(1, timeout − elapsed))`, then repeat.

**Non-overshoot sleep:** the sleep is clamped so the loop never waits past the deadline — the last sleep before timeout is shortened to exactly the remaining budget (floored at 1 ms so it always makes forward progress). The loop therefore returns essentially at the deadline, never materially after it.

**Never hangs on a crashed worker:** because the loop is time-bounded, a crashed worker holding a stale lock cannot hang the caller indefinitely — the loop returns a non-drained status at the timeout and the caller decides what to do with it. (This spec does not decide; the calling command/tool does.)

## State Transitions

This computation is stateless with respect to the queue: it reads and reports, never writes. The only "state" is the wait loop's local elapsed timer, which advances from 0 to at most the timeout. The observable transition of interest is the verdict flipping from `drained = false` to `drained = true` as the worker drains summary work and releases its summary-drain lock — an external transition this spec merely observes.

## Notable Behavior

- **Two axes decide the verdict; four fields are decoration.** Only the active (non-ingest) count and the worker-blocking flag feed `drained`. Ingest-active, worker-busy, and stale exist for progress messaging and debugging.
- **Wiki/graph ingest is excluded on both axes, and the worker-axis exclusion is now automatic.** Ingest work is excluded from the queued-work axis (it lands in the ingest bucket, not the active bucket) *and* from the worker-busy axis — but the latter no longer needs a phase check: ingest runs under its own separate lock (spec 259), so the summary-drain lock this read consults is simply never held during ingest. There is nothing to special-case; a wiki/graph build cannot make the worker report "busy."
- **"Active unless provably stale" is a fail-toward-waiting rule.** An entry with a missing/garbled creation instant is counted as active summary work, so the wait path errs on the side of waiting for a possibly-pending summary rather than declaring "drained" and dropping it. The timeout caps the cost.
- **`blocking` equals `held`, and both come from one lock read.** Because they are derived from a single read of the one summary-drain lock, the two can never contradict — the impossible pair `held = false, blocking = true` is unrepresentable without any gating logic. This is a simplification of an earlier design that read a separate worker-phase marker and had to gate the two axes against a cross-process release race.
- **Corrupt entries count differently in the two counters.** The verdict-feeding by-kind counter ignores an unreadable entry (neither summary nor ingest); the informational stale counter counts it as stale. This is intentional — one asks "is there active summary work?", the other "is there junk to clean up?".
- **The input-hardening choke point exists specifically for the programmatic caller.** The CLI command guards its own timeout before calling in, but the wait loop must still self-harden because the MCP tool forwards its client-supplied timeout straight through; a non-numeric value there would otherwise spin the loop hot.
- **Drained is checked before timeout in the loop.** On the tick where both are true, the loop returns `drained`, so a wait that drains exactly at the deadline reports success, not timeout.

## Shared Behavior

- The pending-work queue's on-disk layout and the individual entry format are owned by specs 34 (queue worker) and 35 (queue entry format). The **ingest** operation kind (the excluded kind) is documented there and in the ingest-trigger spec (159).
- The summary-drain lock's identity, five-minute staleness timeout, acquisition/release, and heartbeat are owned by spec 34; this spec only reads the lock's freshness against that timeout. The separate per-worktree ingest lock is owned by spec 259 and is never read by this computation.
- The seven-day queue-entry stale threshold is owned by specs 34/35; this spec applies it when classifying entries as active versus stale.
- The CLI surface that reports/blocks on this verdict is owned by spec 240; the programmatic (MCP) tool that wraps the same read and wait is owned by spec 148.
