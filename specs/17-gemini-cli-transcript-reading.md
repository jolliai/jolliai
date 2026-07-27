# 17 — Gemini CLI Transcript Reading

## Topic Statement

This spec defines how a Gemini CLI session transcript is read from a single-document JSON file, mapped into the canonical normalized message form, and resumed incrementally on subsequent reads via a per-session cursor.

## Scope

**In scope**

- Detection of Gemini CLI presence on disk.
- The on-disk shape of a Gemini session file (single JSON document, not newline-delimited).
- The internal messages-array shape and the per-message record fields the reader consumes.
- Role mapping from Gemini message types to the canonical role tags.
- Filtering of non-conversational message types.
- Content extraction supporting both string content and an array-of-parts content shape.
- The cursor structure used for incremental resumption (indexed by message position, not byte/line offset).
- The optional time-cutoff filter that lets a queue-driven caller attribute records to a specific commit boundary.
- Same-role coalescing of consecutive entries.

**Out of scope**

- Per-project session selection / discovery (which session file belongs to which project).
- The session-tracking layer that records when a Gemini session started/ended.
- The downstream LLM call that consumes the assembled context.
- Persisting the cursor across runs.
- Building the multi-session merged context (handled by a shared context-assembly layer).

## Data Contracts

### Detection

Detection is a directory-existence check: Gemini CLI is considered present when the user's home contains a Gemini CLI data directory. The check is a single `stat`; absence is silent.

### Transcript file format

A Gemini session is a single JSON document — not newline-delimited. The document is an object that carries a `messages` array. Each element of `messages` is a message record.

### Message record (input)

| Field       | Type                                  | Notes                                                                                            |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `id`        | string                                | Per-message identifier.                                                                          |
| `type`      | string                                | One of `"user"`, `"gemini"`, `"info"`, `"error"`, `"warning"`, possibly other diagnostic kinds.  |
| `timestamp` | string                                | ISO 8601 instant.                                                                                |
| `content`   | string, or array of part objects, or absent | A part object carries an optional `text` string; only parts whose `text` is a non-empty string contribute. |

### Normalized entry (output)

| Field       | Type                       | Notes                                                          |
| ----------- | -------------------------- | -------------------------------------------------------------- |
| `role`      | `"human"` or `"assistant"` | `"user"` is mapped to `"human"`; `"gemini"` is mapped to `"assistant"`. |
| `content`   | string                     | Trimmed text content (see Behavior).                           |
| `timestamp` | string                     | The record's `timestamp`.                                      |

### Cursor

| Field            | Type   | Notes                                                                                            |
| ---------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `transcriptPath` | string | The session file's absolute path.                                                                |
| `lineNumber`     | int    | Reused as a message-array index: count of messages already consumed on prior reads.              |
| `updatedAt`      | string | The wall-clock instant the cursor was produced.                                                  |

A null/absent cursor means "start from the first message."

### Read result

Returned shape is the same as for every other source: the produced entries, the new cursor, and a count of messages actually consumed during this call.

## Behavior

### Read flow

1. Read the entire session file as text.
2. Parse it as a single JSON document.
3. Read the `messages` array (treat absent as empty).
4. Skip the first `cursor.lineNumber` messages.
5. For each remaining message in order, apply the time-cutoff check (see below) and the per-message rules below; collect an entry when the message produces one. Stop when the cutoff says to.
6. Coalesce consecutive same-role entries.
7. Compute the new cursor (see "Cursor advancement").

### Per-message rules

- A message whose `type` is `"user"` extracts its content text. If the extracted text is non-empty after trim, emit `{ role: "human", content, timestamp }`; otherwise drop.
- A message whose `type` is `"gemini"` extracts its content text. If the extracted text is non-empty after trim, emit `{ role: "assistant", content, timestamp }`; otherwise drop.
- Any other `type` (informational, error, warning, or unknown) is silently dropped.

### Content extraction

- If `content` is a string: trim. Return null if empty, otherwise return the trimmed string.
- If `content` is an array: walk it, keep only objects whose `text` is a string, trim each, drop the empties, join the survivors with newlines. Return null if nothing survives.
- If `content` is anything else (including absent): return null.

### Same-role coalescing

After per-message processing, runs of consecutive same-role entries are merged into a single entry with their content joined by a blank line and the earliest timestamp preserved. This is the same coalescing rule used by the Claude Code reader, applied because Gemini may also emit logically-one assistant turn split across multiple records.

### Cursor advancement

- **Without a time cutoff**: the new cursor's `lineNumber` is the total length of the `messages` array (positioned at end). Subsequent calls only see messages appended after this read.
- **With a time cutoff**: the new cursor's `lineNumber` is the index just past the last consumed message. The next call (with a wider cutoff) picks up the deferred messages.

### Time-cutoff filter

When the caller provides an instant cutoff:

- A message whose `timestamp` is strictly after the cutoff causes the loop to stop without consuming that message.
- A message without a timestamp is consumed (conservatively included).
- The cursor advances only to the last consumed message.

### Read failures

- A missing file or unreadable file aborts the read with an error.
- A document that fails to parse as JSON aborts the read with an error.
- A document with an absent or empty `messages` array yields zero entries; the cursor still advances to zero (or stays at the cursor's start).

## State Transitions

The reader is stateless beyond the input cursor; each call returns entries and a new cursor and does not mutate the session file.

The cursor's `lineNumber` is monotonically non-decreasing across reads of the same session file as long as Gemini CLI only appends messages.

## Notable Behavior

- **Single-document JSON, not newline-delimited records**: this is the structural difference from the other sources. The reader loads and parses the whole file each call.
- **No per-byte / per-line cursor**: the cursor field named `lineNumber` is repurposed as an index into the `messages` array. The same field name is reused for shape uniformity with the line-oriented readers.
- **Always full document parse per read**: there is no streaming/line-by-line mode. Resumption avoids re-emission, but does not avoid re-parsing.
- **Two roles only survive normalization**: `user` and `gemini`. Diagnostic types (info, error, warning, and any unknown future kinds) are silently dropped.
- **Mapping is fixed**: `user → human`, `gemini → assistant`. There is no configurability.
- **Empty parts are skipped per-part, not per-message**: a part array with mixed empty/non-empty parts contributes the non-empty ones only; an array of all-empty parts produces no entry.
- **Same-role coalescing keeps the earliest timestamp** of the run.
- **Detection is silent on absence**: an absent Gemini directory is logged at debug level only; the rest of the system carries on as if Gemini is not present.

## Shared Behavior

- **Canonical entry shape** (`{ role: "human"|"assistant", content, timestamp }`) matches every other source reader in this product, so downstream consumers do not branch on source.
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other source reader; the field is reused even though the unit it counts is messages, not lines.
- **Same-role coalescing** is shared with the Claude Code reader and applied with the same semantics.
- **Time-cutoff filter** matches every other source reader: cutoff stops consumption, cursor advances only past consumed records, untimed records are conservatively included.
