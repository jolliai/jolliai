# 16 — Claude Code Transcript Reading

## Topic Statement

This spec defines how a Claude Code session transcript is read from local newline-delimited records, normalized into a canonical role-tagged message form, and resumed incrementally on subsequent reads via a per-session cursor.

## Scope

**In scope**

- The on-disk location convention for a Claude Code session transcript.
- The line-level record shape that the reader recognizes.
- Which record types yield messages and which are silently dropped.
- Cleaning rules applied to user messages (IDE-injected tag stripping, system-noise prefix filtering).
- The rule that consecutive same-role records (streaming chunks of one response) are coalesced into a single normalized entry.
- The cursor structure used for incremental resumption.
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- The token-usage figures the read returns alongside the entries, and the fact that a model response spread over several records is counted once per read.
- The character-budgeted context-string assembly used to feed an LLM, including a default per-call budget.
- Behavior on partial / blank / unparseable lines.

**Out of scope**

- Discovering which session is active (delivered by a session-tracking layer).
- Parsing transcripts produced by other AI coding agents (Codex, Gemini, OpenCode, Cursor, Copilot CLI, Copilot Chat).
- The downstream LLM call that consumes the assembled context.
- Persisting the cursor across runs.
- Multi-session merging policy beyond noting that the same normalized record shape is reused.

## Data Contracts

### Transcript file location

The transcript lives under the user's Claude Code state directory, in a per-project subdirectory whose name is a deterministic encoding of the project's absolute path, with one file per session named by the session's UUID. The file contains one record per line.

### Record envelope (one per line)

Each non-blank line is a JSON object. Recognized records carry:

| Field              | Type            | Notes                                                                                                  |
| ------------------ | --------------- | ------------------------------------------------------------------------------------------------------ |
| `message`          | object          | Required for any record that may produce an entry; absence drops the line silently.                    |
| `message.role`     | string          | Either `"user"` or `"assistant"`. Any other value drops the line silently.                             |
| `message.content`  | string or array | Either a plain text string, or an array of typed blocks `{ type, ... }` of which only `type:"text"` blocks are extracted; their `text` fields are concatenated with newlines. |
| `timestamp`        | string          | Optional ISO 8601 instant carried through onto the produced entry.                                     |
| `isCompactSummary` | boolean         | When `true`, the line is a compaction summary and is silently dropped.                                 |

Non-message records (system events, tool invocations, tool results, streaming-status frames, compaction summaries, IDE-event records, and any other shape that lacks a `message` object with a recognized role) are silently dropped.

### Normalized entry (output)

| Field       | Type                                        | Notes                                                          |
| ----------- | ------------------------------------------- | -------------------------------------------------------------- |
| `role`      | `"human"` or `"assistant"`                  | `"user"` is mapped to `"human"`; `"assistant"` is preserved.   |
| `content`   | string                                      | Cleaned text content (see Behavior).                           |
| `timestamp` | string or absent                            | The record's `timestamp` if present, otherwise absent.         |

### Cursor

| Field            | Type   | Notes                                                                                       |
| ---------------- | ------ | ------------------------------------------------------------------------------------------- |
| `transcriptPath` | string | The transcript file's absolute path.                                                        |
| `lineNumber`     | int    | The number of lines already consumed on prior reads. Next read starts at this index.        |
| `updatedAt`      | string | The wall-clock instant the cursor was produced.                                             |

A null/absent cursor means "read from the beginning."

### Read result

A read returns the list of normalized entries produced by this call, the new cursor, a count of how many lines were actually consumed during this call, and the token figures for the consumed slice: a scalar total and its three-segment breakdown — **always present**, and both zero for a producer whose records carry no usage counters — plus an optional per-model split, omitted entirely when the producer exposes no per-model capture or when the split would be empty. The segment semantics, the counter mapping, and the cost pricing are owned by **Token Usage Extraction and Cost Estimation**; what belongs here is that the figures are a property of *this read's consumed slice*, not of the file.

## Behavior

### Read flow

1. Open the transcript file and load its full text.
2. Split into lines and discard blank/whitespace-only lines.
3. Skip the first `cursor.lineNumber` lines (or zero if the cursor is absent).
4. For each remaining line, attempt to parse it as JSON and apply the record-recognition and cleaning rules below. Lines that fail JSON parsing or that don't match a recognized record shape produce no entry but do not abort the read.
5. After the line loop, coalesce consecutive same-role entries (see "Same-role coalescing").
6. Compute the new cursor (see "Cursor advancement").

### Record recognition and cleaning

- A line whose envelope sets `isCompactSummary: true` is dropped without inspection.
- A line lacking a `message` object with a `role` of `"user"` or `"assistant"` is dropped.
- For an `assistant` record:
  - Extract the text content (string content is taken as-is; array content keeps only `type:"text"` blocks, joining their `text` values with newlines).
  - Trim. If empty, drop.
  - Emit `{ role: "assistant", content, timestamp? }`.
- For a `user` record:
  - Extract the text content as above.
  - Strip IDE-injected context tags. The tag set stripped includes (but is not limited to) markers for system reminders, IDE-opened-file notifications, IDE selection captures, local-command caveats, and slash-command name/message/args/stdout records. The stripper removes the open tag, its content, and the matching close tag.
  - Trim. If the result is empty, drop.
  - If the cleaned content begins with a known system-injection prefix (skill-injection preambles, user-cancellation interruption markers), drop.
  - Emit `{ role: "human", content, timestamp? }`.

### Same-role coalescing

After per-line processing, walk the entry list and merge any run of consecutive entries that share the same role into a single entry whose `content` is the run's contents joined by a blank line, and whose `timestamp` is the earliest timestamp present in the run. This collapses the multi-line streaming-chunk pattern (a single API response surfaces as several consecutive same-role lines) into one logical turn.

### Cursor advancement

- **Without a time cutoff**: the new cursor's `lineNumber` is the count of all non-blank lines in the file (i.e., positioned at end-of-file). Subsequent calls will see only lines added after this read.
- **With a time cutoff**: the new cursor's `lineNumber` is the index just past the last line actually consumed before the cutoff caused the loop to stop. This lets the next call, which carries a wider cutoff, pick up the still-pending lines.

### Time-cutoff filter

When the caller provides an instant cutoff:

- Any line whose record has a `timestamp` strictly after the cutoff causes the read loop to stop without consuming that line.
- Lines without a timestamp are conservatively treated as belonging to the current window (they are written before the next timestamped line, so they are included).
- The cursor is advanced only to the last consumed line, leaving the deferred lines for the next call.

### Usage accumulation within one read

Usage is read from raw lines, not from produced entries, and it is accumulated
over exactly the lines the read consumed (so the time cutoff bounds it the same
way it bounds the cursor). Two rules are specific to the read:

- **A response is counted once per read.** The producer writes one record per
  content block of a single model response and repeats that response's whole
  usage object on each, so the read keeps a set of response identities it has
  already counted and skips repeats. A record that carries no identity always
  counts. The rule, its measured inflation, and the first-seen-wins consequence
  are owned by **Token Usage Extraction and Cost Estimation**.
- **That set is local to one read.** It is created empty at the start of every
  read and discarded at the end; nothing about it is written to the cursor. So a
  response whose records straddle the time cutoff is counted by this read and
  again by the next one. The over-count is bounded at one response per cutoff
  boundary and is accepted.

The per-model split (when the producer supports one) is computed over the same
consumed lines and de-duplicates on the same identities, so it can never
disagree with the segment breakdown about what was counted.

### Context-string assembly (character-budget rule)

When the read result is rendered into a single LLM-facing string:

- Each entry is formatted with a role prefix `[Human]: ` or `[Assistant]: ` followed by its content.
- Entries are walked from newest to oldest, appended (in original order) until the accumulated character count plus separators would exceed the configured budget. The budget defaults to 150000 characters.
- The selected entries are joined by blank lines.
- The result is "the most-recent entries that fit," preserving original ordering.

### Partial last line

If the file's last line is incomplete (no trailing newline) the line still appears in the split result. If it is empty, it is discarded as blank. If it parses, it is processed; if not, it produces no entry and the next read will see whatever the producer wrote next at the same line index.

### Bad lines

A line that fails JSON parsing, or that parses but doesn't match the recognized envelope, produces no entry; it does not abort the rest of the read. The cursor still advances past it on a non-cutoff read; with a cutoff, it advances per the cutoff rules.

## State Transitions

The reader is stateless beyond the input cursor: each call takes a transcript path and an optional cursor, returns entries and a new cursor, and does not mutate the transcript. The cursor's `lineNumber` is monotonically non-decreasing across successive reads of the same file.

## Notable Behavior

- **Transcript files are append-only newline-delimited records**; reading always proceeds line-by-line from the cursor position forward.
- **Compaction summaries are dropped** even though they carry a message envelope, because they synthesize a recap rather than reflect a real turn.
- **Tool-use blocks are silently discarded** from assistant records; only `text` blocks survive into the normalized entry. The rationale is that the surrounding diff context already captures code-touching effects.
- **IDE-injected tags are stripped before noise-prefix filtering**, so a user message that begins with an IDE opened-file tag and is otherwise system-generated still ends up dropped.
- **Coalescing happens after line-level filtering**, so dropped streaming chunks do not "split" what was logically one assistant turn.
- **Same-role coalescing keeps the earliest timestamp** of the run, not the latest, so the merged turn aligns with when the model started speaking.
- **The character budget is a per-call default applied after read**: the read itself does not truncate; truncation belongs to the context-assembly step.
- **Usage is counted per model response, not per record.** One response is written across several records that each repeat its whole usage object; the read counts the first and skips the rest. (Surprising; see **Token Usage Extraction and Cost Estimation** for why summing per record inflated totals several-fold.)
- **The de-duplication set does not survive the read.** A response whose records fall on both sides of the time cutoff is counted by both reads. Bounded and accepted, because the cursor stores no response identity (see **Transcript Cursor Resumption**). (Surprising; intentional.)
- **The cursor field is named `lineNumber`** but its semantics are "lines already consumed," so it equals the count, not the last-index.
- **Same-role coalescing is idempotent**: applying it twice produces the same output.

## Shared Behavior

- **Newline-delimited record format**: the transcript is read as one record per line; blank lines are skipped.
- **Single-pass read**: each call walks the file once from the cursor forward.
- **Lossy normalization**: only `text`-bearing user and assistant turns survive; everything else is discarded.
- **Canonical entry shape** (`{ role: "human"|"assistant", content, timestamp? }`) is the same shape produced by every other transcript-source reader in this product, so downstream consumers do not branch on source.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` is the same shape used by every other transcript-source reader in this product.
- **The token figures a read returns** are defined and priced by **Token Usage Extraction and Cost Estimation**, attributed per conversation by **Commit-Pipeline Conversation Token Attribution**, and summed cursorlessly for the review panel's live meter by **Conversation Token Totals for the Review Panel**. This spec owns only the fact that they describe the consumed slice and are de-duplicated within a single read.
