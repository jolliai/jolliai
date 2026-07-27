# 244 — Conversation Token Totals for the Review Panel

## Topic Statement

Sum real per-conversation token usage across a caller-supplied set of Claude
transcripts to drive the "Next Memory" review panel's live token meter, tolerating
per-transcript read failures and distinguishing "reporting" conversations from the
total count.

## Scope

**In scope**

- The input: a caller-supplied ordered list of conversations, each tagged with its producer source and its transcript path.
- The Claude-only filter applied before any read.
- The full re-read (no cursor) of each Claude transcript from its beginning on every call, performed concurrently.
- The best-effort degradation: a per-transcript read failure counts as a zero contribution rather than failing the whole total.
- The returned aggregate: the three segment sums, the scalar total, a reporting count, and a total count.
- The rule that only a conversation whose breakdown sum is strictly greater than zero increments the reporting count.
- The explicit non-responsibility for exclusion: the caller filters before calling in.

**Out of scope (boundaries)**

- Extraction of a per-turn breakdown from a single transcript line, and the cache-read exclusion rule (see [243 — Token Usage Extraction and Cost Estimation]).
- Pricing the summed tokens into a dollar figure (see [243 — Token Usage Extraction and Cost Estimation]).
- Commit-pipeline per-conversation attribution, cursor advancement, and the stored per-commit total (see [245 — Commit-Pipeline Conversation Token Attribution]).
- How the caller derives which conversations are "selected" / "checked" (see [155 — Active Session Aggregator] and [188 — Commit Exclusion Selection Store]).
- How the transcript itself is read line-by-line (see [16 — Claude Code Transcript Reading]).

## Data Contracts

### Input entry

Each input entry carries:

- `source` — the producer that generated the conversation.
- `transcriptPath` — the absolute path to that conversation's transcript.

### Returned totals

The result is the three segment sums (`input`, `output`, `cached`), plus:

- `total` — the scalar sum `input + output + cached`.
- `reportingCount` — how many input entries actually contributed a non-zero read (Claude source, read succeeded, and a strictly-positive breakdown sum).
- `totalCount` — the number of input entries supplied, counted before any filtering.

An empty input yields all-zero sums, a zero total, a zero reporting count, and a
zero total count.

## Behavior

### Aggregation flow

1. Set `totalCount` to the number of input entries (every entry counts here,
   regardless of source or readability).
2. Keep only the entries whose source is Claude; discard every other source
   before reading. Non-Claude producers carry no usage data, so they can count
   toward `totalCount` but can never contribute tokens or increment
   `reportingCount`.
3. For each kept Claude entry, read its transcript **from the beginning** — with
   no cursor, no time cutoff — and take the read's per-segment breakdown. The
   reads are performed **concurrently**: a multi-conversation selection would
   otherwise serialize N file reads on every debounced meter refresh.
4. A read that throws (moved / deleted file, permission error) degrades to a
   missing contribution for that one entry; it never fails the whole total. (No
   settled-results wrapper is needed because the per-entry failure is already
   caught and converted to a skip.)
5. For each contribution that exists and whose `input + output + cached` is
   strictly greater than zero, add its three segments into the running sums and
   increment `reportingCount`. A readable-but-empty transcript (a real read that
   summed to zero) is intentionally not counted, so it does not inflate the
   reporting count.
6. Return the three sums, their scalar total, `reportingCount`, and `totalCount`.

### Full re-read every call — a notable divergence

This computation reads each transcript from its beginning **on every call**,
with no cursor. It is therefore a whole-conversation figure, not a "since the
last commit" delta. This is a deliberate divergence from the commit pipeline,
which uses per-transcript cursors to attribute only the still-pending slice of a
conversation to a commit (see [245 — Commit-Pipeline Conversation Token
Attribution] and [16 — Claude Code Transcript Reading]). The review-panel meter
and a commit's stored figure are therefore expected to differ and are not the
same number.

### Exclusion is the caller's job

This computation has no exclusion logic. It sums exactly the conversations it is
handed. The review panel filters its conversation snapshot down to the currently
selected / checked rows before calling in, so an unchecked conversation is simply
not present in the input. How "selected" is derived — active-session enumeration
and the sticky exclusion store — is defined elsewhere (see [155 — Active Session
Aggregator] and [188 — Commit Exclusion Selection Store]).

## State Transitions

Stateless. Each call takes a list of entries and returns the aggregate; it reads
files but mutates nothing, advances no cursor, and persists nothing.

## Notable Behavior

- **Full re-read, no cursor.** The panel figure is a whole-conversation total,
  not a since-last-commit delta, so it deliberately differs from the commit
  pipeline's stored figure. (Surprising; intentional.)
- **Reporting count vs total count.** `totalCount` counts every supplied entry;
  `reportingCount` counts only entries that read as strictly-positive Claude
  usage. A selection of non-Claude or empty conversations yields a positive
  `totalCount` and a zero `reportingCount`, which the meter uses to say "n of m
  reported". (Notable.)
- **Best-effort, never throws.** A single unreadable transcript contributes zero
  and the total still returns; this is a live meter, not a billing figure.
  (Notable.)
- **Concurrent reads.** Reads run in parallel so a large multi-conversation
  selection does not serialize on every debounced refresh. (Notable.)
- **Readable-but-empty does not report.** A conversation that reads successfully
  but sums to zero tokens does not increment `reportingCount`. (Notable.)

## Shared Behavior

- The per-transcript breakdown consumed here is produced by the same extraction
  path as everywhere else in the product (see [243 — Token Usage Extraction and
  Cost Estimation]); the cache-read exclusion applies transparently.
- The summed result is priced with the shared cost estimator (see [243 — Token
  Usage Extraction and Cost Estimation]).
- The "selected" set consumed as input is derived by the active-session /
  exclusion layer (see [155 — Active Session Aggregator], [188 — Commit
  Exclusion Selection Store]).
