# 279. Cursor CLI (cursor-agent) Session Discovery and Transcript Reading

## Topic Statement

This spec defines how the terminal-based `cursor-agent` product's conversation sessions are detected, discovered for the current project directory, and read into the canonical normalized message form, from cursor-agent's own plain JSON/JSONL on-disk layout — a source distinct from, and unrelated in storage format to, the Cursor IDE Composer source.

## Scope

**In scope**

- Detecting cursor-agent's presence by the existence of its session-index directory.
- The home-relative directory layout cursor-agent uses for its session index and its transcript files.
- The session-index store: one JSON metadata file per session, nested under an opaque bucket directory.
- The transcript store: one plaintext JSONL file per session, nested under an opaque, lossily-encoded bucket directory, located purely by the session's own identifier.
- Exact-equality directory attribution (no subdirectory/containment matching).
- The staleness window applied to session discovery.
- The bucket-resolution strategy for locating a session's transcript file, including its in-scan caching optimization.
- The two-tier error-classification policy (whole-scan failures vs. isolated per-item skips).
- Transcript line shapes, role mapping, text-part extraction, and the user-turn tag-unwrapping scheme.
- The embedded free-text timestamp format, its two consumers (the optional commit-boundary cutoff, and the instant stamped on each tool-call tally bucket), and the fact that it is read on every line regardless of whether a cutoff was supplied.
- The per-session tool-call tally this reader produces: which line parts feed it, how repeats are de-duplicated, and how it is reported even when empty.
- Cursor-keyed resumption (line-based), including the append-only trailing-newline handling and the malformed/partial-line retry behavior.

**Out of scope**

- The Cursor IDE Composer source (separate spec; separate embedded-database store; unrelated file layout).
- The shared configuration flag that gates this source together with the Composer source, and any aggregator/status/UI rendering built on top of discovery results.
- The generic downstream title-resolution fallback chain (first-user-message truncation, "untitled session" placeholder) — not exercised for this source, since discovery always supplies a native title when present.
- The generic same-role-coalescing helper's implementation (shared with every other source's reader; behavior only summarized here).
- The downstream consumption of normalized entries (LLM summarization, message counting, etc.).

## Data Contracts

### Detection

cursor-agent is considered installed when its session-index directory exists and is a directory. No runtime/module feature gate applies to this source (unlike embedded-database sources) because its storage is plain JSON and JSONL text files, not a database.

### Directory layout

| Path | Contents |
| --- | --- |
| `~/.cursor` | Root, home-relative on every platform. |
| `~/.cursor/chats/<bucket>/<sessionId>/meta.json` | Session-index metadata, one file per session. `<bucket>` is an opaque directory name never computed or verified by the reader — sessions are matched by content, not by which bucket they sit under. |
| `~/.cursor/projects/<bucket>/agent-transcripts/<sessionId>/<sessionId>.jsonl` | Plaintext transcript, one file per session. `<bucket>` here is a separate, lossily-encoded representation of the working directory; because the encoding loses information it is never decoded — a session's transcript is located purely by scanning bucket directories for a file named after the session id. |

### Session metadata record (`meta.json`)

| Field | Type | Notes |
| --- | --- | --- |
| `cwd` | string | The absolute working directory the session was started from. Must match the target project directory by exact normalized-string equality. |
| `updatedAtMs` | number | Epoch milliseconds. Preferred over `createdAtMs` when present and finite. |
| `createdAtMs` | number | Epoch milliseconds. Used only when `updatedAtMs` is absent. |
| `title` | string | Optional native session title, used as-is (trimmed) when non-empty. |

A session is skipped (not discovered) if `cwd` is not a string, if neither timestamp field yields a finite number, or if the record fails to parse as JSON.

### Session-info record (output of discovery)

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId` | string | The session identifier (shared between the metadata directory name and the transcript file name). |
| `transcriptPath` | string | The absolute filesystem path to the resolved `.jsonl` transcript — not a synthetic locator, since this is a real per-session file. |
| `updatedAt` | string | `updatedAtMs`/`createdAtMs` rendered as an ISO 8601 instant. |
| `source` | string | The literal source tag for this CLI source, distinct from the Composer source's tag. |
| `title` | string, optional | Present only when the metadata record carried a non-empty (post-trim) title; omitted entirely otherwise (never set to an empty string). |

### Transcript line shapes

| Shape | Fields | Meaning |
| --- | --- | --- |
| Turn line | `role` (`"user"` \| `"assistant"`), `message.content` (array of parts, each optionally `{ type, text }`) | A conversational turn. Only parts with `type: "text"` and a string `text` contribute to the entry's content; tool-call parts are dropped from the content but **counted** into the tool tally (see below). |
| Control line | any shape without a recognized `role` | Skipped: produces no entry, but the line still counts as consumed. Its tool-call parts, if any, are still tallied — the tally walk is not gated on the role mapping. |

### Normalized entry (output of read)

| Field | Type | Notes |
| --- | --- | --- |
| `role` | `"human"` \| `"assistant"` | `"user"` → `"human"`, `"assistant"` → `"assistant"`; any other/missing role yields no entry. |
| `content` | string | Extracted, trimmed text (user turns additionally unwrapped — see below). |
| `timestamp` | absent | This reader never populates the entry-level timestamp field, even though it parses an embedded timestamp from user turns. That parsed value goes to the cutoff decision and to the tool-call tally's per-bucket instant instead of onto the entry. |

### Per-session tool-call tally (output of read)

Reported alongside the entries and the cursor, and **always present even when empty** — an empty tally is the recorded fact "this session called no tools", which a consumer must be able to tell apart from a source that records nothing at all. Each bucket carries a display name, a classification, a call count, and optionally the instant of its most recent observed call.

Classification follows the shared naming convention this product's tool tallies use: a name carrying the machine-to-machine tool prefix is split into a server and a tool and recorded as an external-server call (with the server kept as its own field and also folded into the display name, so two servers exposing a same-named tool stay distinguishable); a prefix with no tool segment is malformed and stays attributed to the server rather than being dropped; everything else is a built-in call.

### Cursor (the persistence one, not the IDE)

| Field | Type | Notes |
| --- | --- | --- |
| `transcriptPath` | string | The transcript file's absolute path. |
| `lineNumber` | int | Count of transcript lines (blank lines excluded) already consumed. |
| `updatedAt` | string | The wall-clock instant the cursor was produced. |

### Read-result metadata

The count of lines advanced over in this call is reported alongside the entries and the new cursor.

## Behavior

### Detection

1. `stat` the session-index directory (`~/.cursor/chats`).
2. Report installed only if it exists and is a directory; any error (including absence) reports not-installed, silently.

### Session discovery

1. List the session-index directory's immediate children (bucket directories). Absence (`ENOENT`) yields an empty result with no error. Any other listing failure (e.g. the path is a file, not a directory) yields an empty result with a whole-scan filesystem error.
2. Compute the staleness cutoff (now minus 48 hours) and normalize the target project directory for comparison (separator unification, trailing-slash trim, and case-folding on case-insensitive platforms — the same normalization used for path equality elsewhere in the product).
3. List the transcript-index directory's immediate children (candidate transcript buckets) **once** for the whole scan. Absence is treated as benign — an empty bucket list, because the session index can exist before any transcript has been written yet — and the scan proceeds normally. Any other listing failure aborts the whole scan with a filesystem error, since with no resolvable buckets no transcript could ever be found.
4. For each bucket directory under the session index:
   - List its children (candidate session directories). If this listing fails (e.g. a stray file sits where a bucket directory was expected), skip that bucket entirely without affecting the rest of the scan.
   - For each session directory:
     1. Read and parse its `meta.json`. On any read or parse failure, log and skip this session only — the scan is not aborted and no scan-level error is raised for this case.
     2. Require `cwd` to be a string that, after normalization, exactly equals the normalized target project directory. A session started from a *subdirectory* of the project is **not** attributed to the project — there is no containment/prefix matching, only exact equality.
     3. Determine the session's timestamp as `updatedAtMs`, falling back to `createdAtMs` if absent. If neither yields a finite number, log a warning and skip.
     4. Skip (silently) if the timestamp is older than the staleness cutoff.
     5. Resolve the transcript file: try the bucket last resolved successfully in this scan (if any) first; on a miss, or if none has been resolved yet, scan every transcript bucket in listing order, checking whether the expected `agent-transcripts/<sessionId>/<sessionId>.jsonl` path exists as a regular file. Stop at the first match.
     6. If no bucket yields the file, log and skip this session (no transcript recorded yet).
     7. Remember the bucket that resolved this session as the new "preferred" bucket for the remainder of the scan (an in-memory optimization only — every session belonging to one project is expected to live in the same transcript bucket, so later sessions try it first instead of re-scanning every bucket).
     8. Emit a session-info record with the resolved absolute transcript path, the ISO-rendered timestamp, the fixed source tag, and the metadata's title (trimmed) if it is non-empty.
5. Return the accumulated session-info records (unordered), carrying an error only if step 1 or step 3's top-level listing failed.

### Discovery wrapper

The queue-worker-facing entry point runs the scan against the default (real) directories, logs a warning if the scan carried an error, and always returns just the plain array of sessions — the error channel is stripped for this caller.

### Transcript read flow

1. Read the whole transcript file as text. A read failure (e.g. the file no longer exists) is logged and re-thrown as a new error carrying a fixed descriptive message and the original error's `code` (e.g. `ENOENT`), if it had one.
2. Split on newlines and discard any line whose trimmed form is empty — this removes the phantom trailing segment produced by the file's always-present trailing newline, so a resumed line-count cursor lands exactly on the first newly appended line rather than one past it.
3. Start at the given cursor's line count (or 0 for a fresh read), clamped to the file's current line count.
4. If a cutoff instant was supplied and parses as a valid date, cutoff gating is active; otherwise every line is eligible.
5. Walk the remaining lines in order:
   - A line that fails to parse as JSON is skipped without advancing the consumed-count. Because a later successfully-parsed line unconditionally advances the consumed-count to just past itself, a mid-file parse failure is effectively passed over for good once any later line succeeds; only a parse failure with **no successful line after it in this read** (a transcript file caught mid-write) leaves the consumed-count sitting before it, so it is retried on the next read.
   - Compute the line's embedded timestamp (only user-role lines carry one, inside a tagged region of their text). This happens **unconditionally, on every line, whether or not cutoff gating is active** — the value has a second consumer, the tool-tally bucket stamp below, and computing it only under a cutoff left every bucket timeless on the common (cutoff-free) read.
   - **Then**, only when cutoff gating is active: if a timestamp was found and it is strictly after the cutoff, stop the whole walk immediately — this line and every line after it in the file are left unconsumed, to be picked up by a future read once the cutoff advances past them.
   - Map the line's role; a line without a recognized role produces no entry, but still counts as consumed (its position still advances the cursor).
   - For a role-bearing line, extract text from all `type: "text"` content parts, joined and trimmed. For a user-role line, further unwrap it: strip every timestamp-tagged span from the text first, then take the inner text of a user-query-tagged span if one is present, otherwise use the (timestamp-stripped) remaining text; trim the result. Assistant-role text is used as extracted, with no further unwrapping.
   - If the final content is non-empty, append a normalized entry (with no timestamp field).
   - **Tally this line's tool-call parts**, regardless of whether it produced an entry — a pure tool-call turn yields no entry but is real agent activity, and this is the only place those parts are recorded at all. Each part whose type marks it a tool call and whose name is a non-empty string is counted once, classified by name, and — when this line's embedded timestamp parsed — stamped with that instant as the bucket's most-recent-call time. Repeats are de-duplicated on the part's own call identity when it carries one, and counted unconditionally when it does not: an absent identity means the transcript gave no identity to compare, so dropping the call would lose a real one while counting a repeat only inflates one bucket. When several calls land in the same bucket, the bucket keeps the later of the instants.
   - Either way, the consumed-count advances past this line.
6. Merge consecutive entries of the same role (their text joined with a blank-line separator) — the same merging every other source's reader applies.
7. Return the merged entries, a new cursor whose line count is the final consumed-count, the count of lines advanced over in this call, and the tool-call tally.

### Embedded timestamp parsing

Read on every line, and consumed by two things: the cutoff decision, and the per-bucket instant on the tool-call tally.

- Only present on user-role lines, inside a tagged span of their text; the tag's content is matched anywhere within the span (leading free text such as a weekday name is ignored).
- Expected shape: a three-letter month name, day, four-digit year, 12-hour time to the minute, an AM/PM marker, and a parenthesized UTC offset (a signed one-or-two-digit hour, optionally followed by a colon-optional two-digit minute).
- The month name is matched case-insensitively against a fixed set of three-letter English abbreviations; an unrecognized month, or text that doesn't match the expected shape at all, makes the timestamp unparseable for that line.
- An unparseable or absent timestamp is **not** treated as "after cutoff" — such a line (and, transitively, any run of non-user lines immediately following it, since only user lines are checked) is conservatively kept rather than deferred. Only a line with a timestamp that both parses *and* falls after the cutoff triggers deferral.
- A parsed timestamp is converted to a UTC instant using the stated offset. It is never surfaced on the resulting **entry**, but it is not discarded: it is stamped as the most-recent-call instant on every tool bucket this line contributes to. An unparseable or absent one simply leaves those buckets' instant absent for this line.

## State Transitions

Both discovery and reading are read-only with respect to the on-disk stores. The only state that moves forward is the caller-held cursor's line count, which is non-decreasing across successive reads of the same transcript file as long as cursor-agent only appends to it. The in-scan "preferred bucket" is transient, per-call state — it is not persisted and does not affect which sessions are found, only how many directory checks are needed to find them.

## Notable Behavior

- **The declared parse-error scan kind is unreachable**: every metadata-parse failure is caught and isolated at the per-session level (logged, skipped, scan continues); nothing in the traced code path ever constructs a parse-kind scan error.
- **Two failure tiers, deliberately asymmetric**: a listing failure on the session-index or transcript-index root aborts the whole scan (surfaced via the error channel), while a listing failure on an individual bucket, or a parse failure on an individual session's metadata, is isolated and skipped — because the former makes the rest of the scan meaningless (no bucket list, no possible resolution) while the latter affects only one session.
- **A missing transcript-index root is not an error, for a different reason than a missing session-index root**: the session-index root missing means cursor-agent has no data at all (benign); the transcript-index root missing means sessions exist but no transcript has been flushed yet (also benign) — both degrade to "nothing found" rather than failing.
- **Attribution is exact-equality only**: a session run from a subdirectory of the project is never attributed to it. There is no prefix or containment matching.
- **No runtime feature gate**: unlike sibling sources backed by an embedded database, this source's plain-JSON/JSONL storage means detection never depends on optional runtime module support.
- **The bucket-preference cache changes performance, not results**: a cache "miss" (a session whose transcript lives in a different bucket than the one just resolved) transparently falls back to a full per-bucket scan; it never causes a resolvable session to be missed.
- **The transcript-side bucket encoding is deliberately never decoded**: matching happens by testing for the presence of a same-named session file inside each candidate bucket, not by computing which bucket a given working directory maps to.
- **Entry-level timestamps are dropped even though a timestamp is parsed**: the embedded per-turn timestamp does not propagate into the normalized entry the way it does for sources whose store carries a structured per-message timestamp field. It is not, however, discarded — it reaches the tool-call tally.
- **The embedded timestamp is parsed on every line, including on reads with no cutoff at all.** Doing it only under an active cutoff is the obvious shape and was the wrong one: the value is also the instant stamped on each tool bucket, and the cutoff-free read is the common case, so gating the parse left every bucket in every ordinary read with no recorded call time. The cutoff break itself is unchanged — it still fires only when gating is active and only on a timestamp that both parses and falls after the cutoff. (Surprising; the two consumers have different activation conditions.)
- **The tool-call tally is not gated on the role mapping.** A line whose role this reader does not recognise produces no entry and still has its tool-call parts counted, because a pure tool-call turn is real agent activity that the content extraction deliberately throws away. This tally is the only record of those parts anywhere. (Notable; and it was undocumented in this spec entirely until the per-bucket instant made it load-bearing.)
- **Mid-stream vs. trailing malformed lines are handled differently by construction, not by explicit special-casing**: a malformed line is only ever retried on a later call when it is the last thing in the current read window with nothing valid consumed after it.
- **Title always arrives pre-populated from discovery**: the metadata's own title field is the only title source for this product; there is no per-transcript-line title-parsing fallback for this source (the generic downstream fallback chain's per-source parser for this source is a permanent no-op).

## Shared Behavior

- **Staleness limit of 48 hours** matches the two-day staleness window used by every other discovery-based source in this product.
- **Canonical session-info shape** (`{ sessionId, transcriptPath, updatedAt, source, title? }`) matches every other discovery-based source.
- **Path normalization for directory-equality attribution** (separator unification, trailing-slash trim, case-folding on case-insensitive platforms) is the same normalization used across the product for path comparisons.
- **Canonical normalized-entry shape** (`{ role: "human"|"assistant", content }`) matches every other source reader, aside from this source never populating the optional timestamp field.
- **The per-session tool-call tally, its de-duplication on call identity, its name classification into built-in / external-server buckets, and the always-present-even-when-empty contract** are the shared tally behaviour every tool-recording source reader applies; only the source of the per-bucket instant differs (here, the user turn's embedded free-text timestamp).
- **Cursor-keyed resumption** by `(transcriptPath, lineNumber)` matches every other line-oriented source reader.
- **Same-role coalescing** is applied with the same semantics as every other source reader.
- **Time-cutoff filter** matches the general contract used by every other source reader: a cutoff stops consumption, the cursor advances only past what was actually consumed, and records with no determinable timestamp are conservatively included rather than deferred.
