# 155. Active Session Aggregator

## Topic Statement

A single read-side request returns the ordered list of currently-active AI coding conversations across every supported producer, with each row carrying enough metadata for an "Active Conversations" sidebar to render it without further per-row I/O.

## Scope

**In scope:**

- The fan-out across all supported producers (Claude Code, Codex, OpenCode, Gemini, Cursor, Cursor CLI, Copilot CLI, Copilot Chat, Cline (VS Code), Cline CLI, Devin, Antigravity, Kimi Code), the per-producer failure isolation rules, and the partial-result reporting envelope.
- The per-producer **enabled gate**: the configuration is read once before the fan-out, and every producer's loader short-circuits on its own toggle before touching disk.
- The recency-window filter that drops sessions older than a caller-supplied cutoff.
- The composite identity rule that dedupes intra-producer duplicates while keeping cross-producer rows with the same opaque session identifier distinct.
- The cross-cutting "user-hidden" filter and the rule that hiding is a per-snapshot dismiss, not a permanent block.
- The display-title cascade: native title first, then a producer-specific native-title reader, then a first-user-message fallback, then a constant placeholder.
- The "unread since last summarization" message-count filter that drops rows whose entire transcript has already been folded into a prior commit summary.
- The per-row "is edited" flag derived from the persisted overlay store and the per-row "is selected" flag derived from the persisted commit-exclusion store.
- The output ordering — recency-descending with a tie-break on the session identifier — and the requirement that the result be stable across calls when input data has not changed.
- The two callable entry points: a plain "items only" variant and a diagnostic variant that also carries the set of producers whose loaders reported failure.
- The thin consumer wrapper that adapts the aggregator output for a webview surface, including its handling of a wholesale aggregator throw.

**Out of scope (boundaries):**

- Per-producer transcript discovery itself — how each producer's on-disk or SQLite-backed sessions are scanned, how the scan reports structured errors — is owned by each producer's discovery spec (covered by specs in the 16–22 range and Cursor / Copilot CLI / Copilot Chat / OpenCode equivalents). This spec describes only what each discoverer hands the aggregator and how the aggregator reacts to its failure envelope.
- The Claude/Gemini session registry written by the agent stop hooks, and any pruning of that registry, are owned by the **session registry pruning** spec. This aggregator simply asks the registry for its current contents.
- The overlay store's persistence format, atomicity rules, and conflict resolution are owned by the conversation overlay spec. This aggregator only asks "does this session have any saved edits or deletions" as a boolean.
- The hidden-conversations store's persistence format, lock contract, and corrupt-file recovery are owned by the hidden-conversations spec. This aggregator consumes one predicate from it.
- The commit-exclusion store's persistence format and write-side behavior are owned by the commit-exclusion spec. This aggregator consumes one predicate from it.
- The transcript-cursor file that records "consumed up to here" is owned by the cursor / summary pipeline specs. This aggregator only asks the transcript layer for the "unread slice" the cursor implies.
- The sidebar webview surfaces that render the aggregator's output, including their refresh cadence, debouncing, and message-protocol envelopes, are owned by the sidebar specs in the 100–117 range and the IntelliJ tool-window equivalent (spec 192). Note that the IntelliJ surface is **not** a port of this aggregator: it invokes *this* implementation over a bridge action (see "Consumers" below).
- The detail panel that opens when a row is clicked is its own surface; this aggregator only guarantees that the rows it returns are non-empty when rendered into a panel.

## Data Contracts

### Input

The aggregator takes a single options record:

| Field          | Type    | Meaning                                                                                                                          |
| -------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| project root   | string  | Absolute path of the project the caller is asking about. Drives every producer-specific discovery and every per-project lookup. |
| window         | number  | Maximum age in milliseconds; sessions whose recorded last-update timestamp is older than `now − window` are excluded.            |

The window field is honored as a nullish fallback: when the caller passes `undefined` (or omits the field), a built-in default window applies. The default is **48 hours**.

### Per-row output

Each row in the aggregator's output carries exactly these fields:

| Field             | Type                       | Meaning                                                                                                                                                        |
| ----------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session id        | string                     | The opaque, producer-supplied identifier for the session. Unique within a producer; not unique across producers.                                                |
| producer          | producer enum              | One of the supported producers (see "Producer enum" below). |
| title             | string                     | The resolved display title (see title-cascade below). Never empty; falls back to a constant placeholder when nothing else can be derived.                       |
| message count     | number                     | The number of merged transcript entries in the **unread slice** for this session. Always positive on returned rows; rows whose unread slice is empty are dropped. |
| last activity     | string                     | The session's recorded last-update timestamp, in ISO-8601 form. Drives ordering and the recency filter.                                                         |
| transcript handle | opaque                     | A producer-supplied locator for the underlying transcript, opaque to the consumer and forwarded as-is to any "open detail panel" follow-up call.                |
| is edited         | boolean                    | True when an overlay file with at least one saved edit or deletion exists for this session.                                                                     |
| is selected       | boolean                    | False when the session's row is listed in the commit-exclusion store; true otherwise (the default for any row the user has not explicitly unchecked).           |

### Diagnostic envelope

The diagnostic variant returns an envelope of:

| Field          | Type                  | Meaning                                                                                                                                                |
| -------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| items          | row list              | Same shape as the plain variant.                                                                                                                       |
| failed sources | producer list         | The set of producers whose discovery either threw or returned a structured "error" field. A producer can appear here even when its row list is non-empty. |

The plain variant is exactly the items half of the envelope; both entry points share one implementation and differ only in what they return.

### Producer enum

The aggregator pins a closed enumeration of producers. In declaration order — which is also the order the runtime allowlist and every mirrored consumer enumeration must use:

| Producer key | User-facing display string | Enable toggle it reads |
| --- | --- | --- |
| `claude` | Claude | Claude |
| `codex` | Codex | Codex |
| `gemini` | Gemini | Gemini |
| `opencode` | OpenCode | OpenCode |
| `cursor` | Cursor | Cursor *(shared)* |
| `cursor-cli` | Cursor CLI | Cursor *(shared)* |
| `copilot` | Copilot | Copilot *(shared)* |
| `copilot-chat` | Copilot Chat | Copilot *(shared)* |
| `cline` | Cline (VS Code) | Cline *(shared)* |
| `cline-cli` | Cline CLI | Cline *(shared)* |
| `devin` | Devin | Devin |
| `antigravity` | Antigravity | Antigravity |
| `kimi` | Kimi Code | Kimi Code |

Removing or renaming an entry must happen consistently across the runtime allowlist and every consumer; this spec treats the set as fixed. Three pairs are two on-disk forms of one product sharing a single user-facing enable toggle (Cursor IDE + Cursor CLI; Copilot CLI + Copilot Chat; Cline VS Code + Cline CLI) but remain distinct enum values with distinct discoverers and rows.

A session whose producer field is missing from the producer enum (i.e. the discoverer omitted the field) is treated as **Claude Code** throughout the pipeline — for the enabled gate, for hidden-check, for selection-check, for title resolution, and for the output row's producer field.

### The enabled gate

One predicate maps a producer (or a missing producer, which falls back to Claude Code) plus the loaded configuration to a boolean. Each toggle is **on unless explicitly set to false** — absent means enabled — and the three shared pairs above resolve to their product's single toggle. A producer outside the enumeration answers "enabled".

This predicate is consulted in two places on purpose, and the redundancy is deliberate rather than accidental:

1. **Inside the aggregator**, once per producer, before the loader touches disk.
2. **Again in each consumer**, over both the returned rows and the returned failed-producer list, after the aggregator has answered.

The second pass exists because the consumer loads the configuration itself, concurrently with the call: a save landing between the two reads would otherwise let a just-disabled producer's rows render, or spike the consumer's "sources unavailable" hint for a producer the user has just switched off. In the steady state it is a no-op.

### Title-cascade contract

The title resolver works the same way for every producer. Inputs are: a session info record (with optional native title), the session's producer, the transcript handle, and optionally a pre-loaded merged-entry array (see the cost-saving rule below). The cascade is:

1. **Native title from the session info** — if the discoverer supplied a non-empty native title, use it. Trim to a maximum code-point count.
2. **Producer-specific native reader** — currently only Claude Code has one; it streams the transcript and returns the most-recent producer-emitted "ai title" row's payload. Other producers have no native reader at this layer. This step is additionally skipped when the session carries an **empty transcript handle** (an archived session whose live transcript is gone): opening a read stream on an empty path is a real filesystem round-trip that always fails, so the cascade falls straight through instead.
3. **First-user-message fallback** — find the body of the first non-empty human turn in the transcript, normalize whitespace, and trim to the maximum code-point count.
4. **Constant placeholder** — when nothing above produces a non-empty string, emit a fixed sentinel string (the placeholder is part of the contract; the exact wording is "(untitled session)").

**Code-point truncation.** The maximum is 60 code points. Truncation iterates by Unicode code point (preserving surrogate pairs), collapses internal whitespace to single spaces, and trims leading and trailing whitespace.

**Cost-saving rule.** When the caller has already loaded the merged transcript for another purpose (the unread-slice message count), it passes that array into the resolver. The fallback step then derives the title from the in-memory array instead of re-streaming the file from disk. The producer-specific native reader still runs separately because the merged-transcript stream strips its source rows.

### Per-producer first-user-message parsers

The first-user-message fallback consults a per-producer line parser. Each parser inspects one transcript line and returns the user-message body or undefined; the streaming loop returns the first non-empty body. The parsers honor these per-producer rules:

| Producer       | Match rule                                                                                                              | Body extraction                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code    | Line is a parsed JSON object whose `type` is `"user"`.                                                                  | The body is either a nested `message.content`, falling back to a top-level `content`. String → as-is; array-of-blocks → join `text` (or bare-string) parts. |
| Codex          | Line is a parsed JSON object whose `role` is `"user"`.                                                                  | Top-level `content`; same string-or-array handling as Claude Code.                                                                                       |
| Gemini         | Line is a parsed JSON object whose **`type`** (not `role`) is `"user"`.                                                 | Try `content` first; if absent, accept a top-level `text` string as a final fallback for forward-compat with future schema variants.                     |
| OpenCode       | The parser never matches (always returns undefined).                                                                    | OpenCode sessions always carry a discoverer-supplied native title; this parser is defined for completeness only.                                          |
| Cursor         | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Copilot CLI    | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Copilot Chat   | Two shapes accepted: (A) line is `{ value: { message: { text } } }` or `{ value: { content } }`; (B) line is `{ type: "user.message", data: { content } }`. | Shape A returns the inner `text` or stringified `content`. Shape B returns the stringified `data.content`. Anything else falls through. |
| Cursor CLI     | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Cline (VS Code) | Same as OpenCode.                                                                                                      | Same as OpenCode.                                                                                                                                        |
| Cline CLI      | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Devin          | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Antigravity    | Same as OpenCode.                                                                                                       | Same as OpenCode.                                                                                                                                        |
| Kimi Code      | Line is a parsed JSON object whose `type` marks a turn's prompt event.                                                  | The event's `input`: a bare string as-is, or an array of content blocks joined by the shared array rule below. **This is a real parser, not a stub** — Kimi Code sessions carry a native title only when the session's own state record supplied one, so the fallback genuinely runs. |

A line that fails JSON parsing is skipped silently; the scan continues. A line whose parser throws is caught and the scan continues. The first line that yields a non-empty body wins.

**Stringification of `content`.** Across producers, the body extractor accepts a string verbatim, accepts an array of mixed elements (joining the `text` field of object elements and bare-string elements with single spaces, skipping anything else), and rejects all other shapes (number, plain object without `text`, undefined) by returning undefined so the scan continues.

### Hidden-conversations predicate

The hidden filter is consumed as one boolean: **"is this session still hidden as of its current last-activity timestamp?"** The predicate's contract is "the user dismissed this row at time T; the row stays hidden until the session's last-activity advances strictly past T". Equal timestamps remain hidden. Corrupt timestamps in either argument collapse to "remain hidden" so a corrupted store does not silently unhide the user's intent.

### Commit-exclusion predicate

The selection flag is computed from the commit-exclusion store: the row's selection-key is constructed as a producer-and-session-id composite; if that key is present in the exclusion file, the row's "is selected" field is false; otherwise true. Absence is the default.

### Overlay-edited predicate

The "is edited" flag is computed by loading the per-session overlay record and asking the overlay store whether it contains any saved edits or deletions. Absence of an overlay file is treated as false.

## Behavior

### Single request: end-to-end flow

The aggregator runs the following pipeline on every call. There is **no cache**, **no LLM invocation**, and **no background task** retained between calls; each call is a fresh computation.

1. **Resolve the recency cutoff.** Compute `cutoff = now − window`. The window defaults to 48 hours when the caller passes nullish.
2. **Load the configuration once**, before anything else, and hand the same snapshot to every loader. One read serves the whole fan-out; no loader re-reads it.
3. **Fan out concurrently** to one loader per producer, except that Claude Code and Gemini share a single loader (both write their session metadata into the same per-project registry). The loaders are: the combined Claude-Code + Gemini loader, then the Cursor, Codex, OpenCode, Copilot CLI, Copilot Chat, Cline (VS Code), Cline CLI, Devin, Cursor CLI, Antigravity, and Kimi Code discoverers. Concurrently, also load the hidden-conversations state for this project and the commit-exclusion state for this project. Every loader runs in parallel; the slowest determines the wall-clock floor.

   **Every loader's first act is the enabled gate.** A producer whose toggle is off returns an empty session list and an empty failed list *without opening a file, opening a database, or walking a transcript* — and, critically, without being flagged as failed, because the user switched it off rather than the scan breaking. The combined Claude/Gemini loader handles its two toggles specially: both off skips the shared registry read entirely; exactly one off performs the read and then drops that half's rows.

   The discoverers' own heavier machinery (embedded-database readers and the like) is loaded lazily inside each loader body, so a disabled producer also never pays that load cost.
4. **Combine producer batches** into one flat session list. Each loader returns a "result envelope" of (sessions, failed-producers); the aggregator concatenates the sessions across every envelope and concatenates the failed-producer lists into one set.
5. **Apply the recency filter.** Parse each session's last-activity into milliseconds; drop sessions whose value is below the cutoff.
6. **Dedupe by composite identity.** Build a map keyed by `(producer, session-id)`. For each surviving session, if the key is new, insert it; if the key already exists, keep the entry whose last-activity timestamp is newer. The first-seen entry wins on ties (a strictly-greater comparison).
7. **Apply the hidden filter.** Drop any session whose `(producer, session-id, last-activity)` triple satisfies the "is still hidden" predicate. The producer falls back to Claude Code when missing.
8. **Per-row enrichment** (concurrent across rows; sequential within a row only where needed):
   - Load the **unread slice** of the merged transcript for this session, applying the persisted overlay. On any read failure, treat the slice as empty (and log a diagnostic).
   - Compute the **is-edited** flag by loading the per-session overlay record and checking for saved edits or deletions. On any read failure, treat as false (and log a diagnostic).
   - Compute the **title** via the title-cascade:
     - If the unread slice is non-empty, also load the **full** merged transcript so the title-cascade can fall back against the complete in-memory entry array (preserving title quality for producers without a native reader). On any read failure here, treat the full transcript as empty (and log a diagnostic) — the row still survives because the unread slice was already non-empty; the title degrades to the placeholder.
     - If the unread slice is empty, pass the empty slice into the title-cascade (the row will be dropped by the next step anyway; this avoids a redundant disk pass).
   - Build the output row with the computed fields, the session's producer (defaulting to Claude Code), the session's transcript handle, the session's last-activity timestamp, and the **is-selected** flag (derived from the commit-exclusion store via the composite key).
9. **Drop empty rows.** Any row whose message-count is zero is dropped before sorting. This catches both "session has been fully consumed into a prior summary" and "transcript read failed and degraded to empty".
10. **Sort.** Order rows by last-activity descending. Ties broken by session-id ascending. Use lexicographic comparison on the ISO-8601 timestamp strings (which is order-preserving for well-formed ISO-8601).
11. **Return.** The diagnostic variant returns `{ items, failedSources }`; the plain variant returns just `items`. The two share one implementation.

### Per-loader failure isolation

Each producer loader is wrapped in a per-loader try/catch and additionally inspects a structured error field on its envelope:

- If the discoverer **throws**, the loader catches, warn-logs the error message (handling both Error and non-Error throws), and returns `{ sessions: [], failed: [<that producer>] }`. The rest of the fan-out continues.
- If the discoverer **returns** an envelope with a populated structured error field, the loader warn-logs and returns `{ sessions: <whatever rows the discoverer did get>, failed: [<that producer>] }`. **The partial sessions are preserved** so a discoverer that got some rows before tripping on a locked database still contributes them. The producer is still flagged as failed so the consumer can render a partial-result hint.
- If the discoverer returns an envelope without an error field, the loader returns `{ sessions, failed: [] }`.

The combined Claude-Code + Gemini loader is special: both producers share a single underlying session-registry reader. When that read throws, the loader flags **both** Claude Code and Gemini as failed at once. When that read succeeds, neither is flagged.

### Per-row enrichment: failure isolation

Within a row, each of the three enrichment loads is wrapped in its own try/catch:

- **Unread-slice load failure** → empty slice, warn log, row will be dropped by the empty-row filter.
- **Full-transcript load failure** (only reached when unread is non-empty) → empty array, warn log, title degrades to the placeholder via the in-memory shortcut.
- **Overlay-edited load failure** → false, warn log.

No row failure ever causes the whole aggregator to fail. The row is degraded or dropped, never re-thrown.

### Wholesale aggregator failure (consumer wrapper)

The thin consumer wrapper that adapts the aggregator output for the webview surface adds one more failure layer:

- If the aggregator itself throws (i.e. something outside any per-loader catch crashed — typically an import-time failure or an out-of-memory event), the wrapper catches and returns `{ items: [], failedSources: [<every producer in the closed enum>] }`. The full failed-set is reported because reporting an empty failed-set would be indistinguishable from a healthy-but-empty list, suppressing the partial-result banner on the consumer side.
- On the **success** path the wrapper loads the configuration itself, concurrently with the aggregator call, and re-applies the enabled gate to both the returned rows and the returned failed-producer list (see "The enabled gate"). This is the second of the two gates and is a no-op unless the configuration changed between the two loads.
- On the success path the wrapper also fires a **fire-and-forget** projection of the surfaced sessions into the local statistics store, riding this refresh rather than owning a timer. It never awaits it and never lets it affect the returned value; the projection does its own capability gating, its own change-filtering, and swallows its own failures.
- The wrapper de-duplicates repeated identical aggregator-throw warning logs: a failure with the same message as the immediately-previous failure is **not** re-logged. A successful refresh in between resets the de-duplicator, so the same failure can be logged again after recovery.
- The wrapper short-circuits when no project root is known (no open workspace): it returns `{ items: [], failedSources: [] }` without invoking the aggregator. This is **not** a failure case; the empty failed-set is correct because the system is healthy, it just has nothing to aggregate.

### Title-cascade details

Within the title resolver:

1. If the session info carries a non-empty native title, return it (trimmed to the code-point cap).
2. Otherwise, if the producer is Claude Code **and the transcript handle is non-empty**, run the producer-specific native reader (streams the transcript looking for the most-recent producer-emitted "ai-title" payload). If it returns a non-empty string, return it (trimmed to the cap). If it throws — which is expected to be impossible because the reader itself catches all I/O errors and returns undefined — log at debug and fall through.
3. Otherwise, if the caller pre-loaded the merged transcript, derive the title from the in-memory array: iterate entries, find the first human-role entry whose content trims to non-empty, return its content (trimmed to the cap). If no such entry exists, return the placeholder.
4. Otherwise, stream the transcript line-by-line, calling the per-producer parser on each line, returning the first non-empty body (trimmed to the cap). If the stream itself throws (non-ENOENT — ENOENT is silent), log at debug and return the placeholder. If the loop exhausts without finding a user message, return the placeholder.

The producer-specific native reader for Claude Code pre-filters lines by checking for a literal substring that exactly matches the "ai-title" type marker (with its trailing quote) before attempting JSON parse, so non-title lines never enter the parser. Lines that pass the pre-filter but fail JSON parse are counted and skipped silently; the scan continues so a later valid title-row still wins. The reader returns the most-recent valid title-row's payload, or undefined when no valid row was found. The reader catches ENOENT silently and warn-logs only non-ENOENT failures.

The first-user-message fallback streams the file once, skipping empty lines without invoking the parser. A parser throw on a line is caught and the line is skipped. The first line whose body trims to non-empty produces the title. If truncation reduces the body to an empty string (it shouldn't, given the cap is 60 and the body had non-whitespace content, but defensively), the placeholder is returned instead.

### Output-row computation

The producer field on the output row uses the session's producer when present, falling back to Claude Code when missing. The same fallback applies to all three predicate lookups (hidden, selection, overlay) so a producer-less session is consistently treated as Claude Code throughout.

The transcript handle on the output row is forwarded verbatim from the session info; the aggregator does not normalize, validate, or re-resolve it.

The last-activity field is forwarded verbatim from the session info as an ISO-8601 string.

## State Transitions

This aggregator is fundamentally **stateless across calls**. Each invocation:

- Reads the current state of the project's hidden-conversations store.
- Reads the current state of the project's commit-exclusion store.
- Reads each producer's session list as the discoverer surfaces it.
- Reads each session's overlay file fresh.
- Reads each session's transcript fresh (and its unread slice via the per-session cursor file).
- Computes one snapshot output.
- Returns. Holds no memory of any prior call.

The only stateful element within a single call is the dedup map keyed by `(producer, session-id)` — it lives for the duration of the dedup step and is discarded. The consumer wrapper additionally holds one stateful field (the last-logged failure message string) used solely for log-deduplication; this never affects the returned data.

The aggregator does not poll. It is called by its consumer on demand. Refresh cadence — when to call it again — is owned by the consumer surface (sidebar webview, IntelliJ tool window). The aggregator itself has no notion of "tick".

### Consumers

There is **one** implementation, with two consumers:

- **The webview sidebar** calls it in-process through the thin consumer wrapper described above (which owns the no-workspace short-circuit, the wholesale-throw-to-every-producer-failed substitution, the log de-duplication, the second enabled gate, and the statistics projection).
- **The IntelliJ tool window** calls **this same implementation** out-of-process, over a bridge action, passing the working directory and an **explicit recency window**. There is no second aggregator on that surface. The window the IntelliJ consumer supplies is 48 hours, and the bridge action itself falls back to 48 hours when no window is present in the request — so both paths agree on the default. That consumer's adapter also carries its own hand-written mirror of the enabled predicate and re-filters both rows and failed producers with it, exactly as the webview wrapper does. The panel above it performs the wholesale-failure substitution (spec 192), and because the call crosses a process boundary, a transport failure is indistinguishable from an aggregator crash there.

## Notable Behavior

- **The recency cutoff is strict (`<` cutoff drops, `>=` cutoff keeps).** A session whose last-activity is exactly `now − window` survives. This makes the boundary inclusive of the cutoff itself.
- **Dedup is by composite `(producer, session-id)`, not by session-id alone.** A Claude Code session UUID and a Cursor session hash could collide in the opaque string space; keeping them as separate rows preserves both as genuinely distinct conversations. This is the same identity rule used by the detail panel and the hidden-conversations store. (Surprising; load-bearing.)
- **Intra-producer dedup keeps the most recently updated row.** If a discoverer emits the same session twice in one call (which it should not, but the contract does not formally forbid), the row with the larger last-activity wins; on ties, the first-seen row wins (strictly-greater comparison).
- **Empty-row filtering uses the "unread" slice, not the full transcript.** A session whose entire history has already been folded into a prior commit summary drops out of the active list (because its unread slice is empty), even though the on-disk transcript is non-empty. This is the mechanism by which "consumed conversations" disappear without being deleted. (Surprising; intentional.)
- **A row whose transcript read fails is silently dropped, not surfaced as an error row.** The empty-row filter catches the degraded slice and removes the row. The diagnostic envelope's failed-sources field flags the **producer**, not individual rows. (Notable.)
- **Hiding a row is a per-snapshot dismiss, not a permanent block.** Once the producer records new activity (the session's last-activity advances strictly past the hide timestamp), the row re-surfaces. Without this, long-running sessions in Cursor / Codex / Copilot Chat would stay invisible forever after one "Mark All as Deleted" click. (Surprising; intentional.)
- **Equal timestamps remain hidden.** A session whose last-activity is exactly the hide timestamp is treated as the same snapshot the user just dismissed, not new activity. (Notable; boundary case.)
- **Corrupt hidden-store timestamps default to "remain hidden".** An unparseable hide timestamp or session timestamp keeps the user's hide intent intact rather than silently unhiding. (Notable; defensive.)
- **The title-cascade's Claude-Code native-reader path is independent of the merged-entries shortcut.** The shortcut covers the first-user-message fallback only; the Claude-Code native reader always runs its own stream because the merged-transcript layer strips its source rows. So Claude Code sessions cost one extra stream pass per refresh even when the caller supplied merged entries. (Notable.)
- **Several first-user-message parsers are always-undefined stubs, and one recently-added producer's is not.** OpenCode, Cursor, Copilot CLI, Cursor CLI, Cline, Cline CLI, Devin and Antigravity all carry a discoverer-supplied native title that short-circuits the cascade at step 1, so their parsers exist for shape-completeness and reaching them in production means a discoverer regression (the cascade falls through to the placeholder). Kimi Code is the exception: its discoverer supplies a title only when the session's own state record had one, so its parser is a real one that reads the turn's prompt event. Do not assume "new producer ⇒ stub". (Notable.)
- **The Gemini parser keys on `type === "user"`, not `role === "user"`.** Early versions used `role` and silently produced "(untitled session)" for every Gemini session even when the transcript clearly had user turns. The current parser also accepts a top-level `text` string as a final fallback for forward-compat. (Notable; bug-fix preserved as contract.)
- **The Copilot Chat parser accepts two distinct on-disk shapes.** Both must be supported because the transcript-loader layer supports both; if the parser only handled one, sessions on the other shape would show "(untitled session)" in the sidebar even though the detail panel rendered them correctly — a "details work, title is wrong" split that the design explicitly rules out. (Notable; bug-fix preserved as contract.)
- **The Claude Code native title reader returns the LAST `ai-title` row in the file**, not the first. Claude Code re-evaluates the title continuously and appends a new row each time; the most recent row reflects the current title. (Notable.)
- **The Claude Code native reader's pre-filter checks for an exact literal substring including its trailing closing quote.** A line whose `type` is "ai-title-other" cannot pass the pre-filter even though it shares the prefix. This makes the post-parse `type !== "ai-title"` check redundant. Removing the pre-filter would still produce correct results but would JSON-parse every line. (Notable.)
- **A loader can both return rows and be flagged as failed.** Discoverers may surface a partial result (some rows came back before the underlying scan tripped). The aggregator preserves the rows and flags the producer in failedSources so the consumer can render a partial-result hint. (Notable.)
- **The combined Claude-Code + Gemini loader flags both producers as failed at once when their shared registry read throws.** Neither producer has independent storage; their session metadata co-lives in one file. (Notable.)
- **The wholesale-throw path in the consumer wrapper reports every producer as failed**, not an empty failed-set. An empty failed-set would be indistinguishable from a healthy-but-empty list and would suppress the consumer's partial-data banner, hiding a broken aggregator from the user. (Notable; intentional.)
- **The consumer wrapper de-duplicates repeated identical aggregator-throw warning logs.** A failure with the same message as the immediately-previous failure is not re-logged; a successful refresh resets the de-duplicator. This prevents log spam on a stuck failure. (Notable.)
- **The consumer wrapper's "no workspace" short-circuit returns an empty failed-set**, distinguishing it from a wholesale-throw. The webview can rely on this to suppress the partial-data banner when there is simply no project to aggregate. (Notable.)
- **A disabled producer costs nothing and is not reported as broken.** Its loader returns before opening anything, and it is deliberately absent from the failed-producer list — otherwise turning a producer off would light up the consumer's "some sources failed to load" banner, telling the user their own choice was a malfunction. (Notable; the empty-failed-list half is the easy part to get wrong.)
- **The enabled gate is applied twice on purpose, and the second application is not redundancy.** The aggregator gates before reading disk; each consumer re-filters both the rows and the failed-producer list afterwards. The consumer loads the configuration concurrently with the call, so the two can disagree only in the window where a save lands mid-call — which is exactly the window where a just-disabled producer would otherwise render rows, or spike the unavailable-sources hint. (Notable; belt-and-braces against configuration drift, not duplication.)
- **Three producers do not have a toggle of their own.** Cursor CLI rides the Cursor toggle, Copilot Chat rides the Copilot toggle, and Cline CLI rides the Cline toggle. Switching one of those products off silently removes two producers' rows. (Notable.)
- **The aggregator never invokes an LLM and never writes to disk.** The pipeline is pure-read; the only writes happen out-of-band via the hidden-conversations / commit-exclusion / overlay stores when the user takes UI actions, all owned by their respective specs. The statistics projection that rides the webview consumer's refresh is the consumer's, not the aggregator's. (Notable; load-bearing.)
- **The aggregator holds no cache between calls.** Every call re-reads every input. This trades CPU for freshness; a consumer that calls on a tick interval (e.g. ~60s for the sidebar) re-pays the cost each tick. (Notable.)
- **Title truncation is by Unicode code point, preserving surrogate pairs.** A title made entirely of astral-plane emoji is truncated by character count, not UTF-16 code unit, so no row produces a half-truncated surrogate. Internal whitespace is collapsed to single spaces before truncation. (Notable.)
- **A line whose JSON parses but whose body extractor returns undefined does not abort the first-user-message scan.** The scan continues, so a follow-up valid line still produces a title. The same is true of array-content lines whose elements contain no extractable text. (Notable.)
- **Empty lines in a JSONL transcript are skipped before the per-producer parser is called.** Producers that flush a trailing newline after every commit thus do not waste a parser invocation. (Notable.)
- **The Codex / Gemini / Copilot Chat per-line parsers exist alongside the Claude Code parser in one shared resolver**, so the aggregator can stay agnostic of transcript schemas. Adding a new producer with a JSONL transcript requires adding one parser; producers without a JSONL transcript (those that always carry a native title) get an always-undefined stub. (Notable.)
- **The "is edited" flag is derived from the persisted overlay, not from any in-memory edit state.** Closing and re-opening the detail panel without saving does not affect the flag. (Notable.)
- **The "is selected" flag defaults to true.** A row that does not appear in the commit-exclusion store is considered selected. The commit-exclusion store only records exclusions, not selections, so it never grows with healthy use. (Notable.)
- **The sort uses a lexicographic compare on the ISO-8601 strings**, which is order-preserving for well-formed timestamps. This avoids paying the cost of `Date.parse` per row at sort time. A malformed timestamp could subtly mis-sort itself but the rest of the list remains sorted. (Notable.)
- **The placeholder title is the exact string `(untitled session)`.** This string is part of the contract and is what the sidebar will display when no title is derivable. (Notable.)
- **The default recency window is exactly 48 hours (2 × 24 × 60 × 60 × 1000 ms).** This is also the window the VS Code consumer wrapper hard-codes, the window the IntelliJ consumer passes explicitly over the bridge, and the fallback the bridge action applies when the request omits it. All three agree on 48 hours today; any surface is free to pass a different window. (Notable.)
- **There is exactly one aggregator, not one per surface.** The IntelliJ tool window reaches this implementation over a bridge action rather than re-implementing it, so per-producer discovery, the recency filter, the title cascade, dedup, empty-row filtering, and the failed-source envelope have a single behavior across surfaces. Only the wholesale-failure substitution and the refresh cadence remain per-consumer. (Notable.)

## Shared Behavior

- Per-producer transcript scanning, including the structured `{ sessions, error? }` envelope each discoverer returns, is defined by the per-producer discovery specs (Codex, Cursor, OpenCode, Copilot CLI, Copilot Chat, Gemini), plus the Claude / Gemini session-registry write path (the stop-hook session-recording specs). This aggregator consumes their outputs.
- The orphan-branch-backed transcript layer that the merged-transcript and unread-slice helpers ultimately read is defined by the orphan-branch summary storage and transcript-loader specs.
- The cursor file that determines the unread slice for each transcript path is owned by the cursor / summary-pipeline specs.
- The hidden-conversations store, its lock contract, and its "is still hidden" predicate are defined by the hidden-conversations spec; this aggregator consumes the predicate.
- The commit-exclusion store and its composite key construction are defined by the commit-exclusion spec; this aggregator consumes the predicate.
- The conversation overlay store and the "has edits or deletions" predicate are defined by the conversation-overlay spec; this aggregator consumes the predicate.
- The session-registry pruning that bounds the Claude / Gemini registry's size is defined by the **session registry pruning** spec; pruning is what keeps the combined loader's read cheap.
- The sidebar surfaces that consume this aggregator's output, their refresh cadence, and the message-protocol envelopes that ship the rows to a webview are defined by the VS Code sidebar specs (100–117 range) and the IntelliJ tool-window equivalent (spec 192). The IntelliJ consumer invokes this aggregator over a bridge action with an explicit window; it does not re-implement it. The producer enumeration it deserializes into must stay in lockstep with this aggregator's own producer list.
- The detail panel that opens when a row is clicked is its own surface, with its own spec; this aggregator only guarantees that the rows it returns are non-empty when rendered.
