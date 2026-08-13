# 182. Session Title Resolution Chain

## Topic Statement

A single call resolves the display title for one AI coding session by consulting an ordered chain of sources, returning a constant placeholder when no source yields a non-empty string — plus a second entry point that runs the same chain against an already-archived slice of conversation and answers "absent" instead of the placeholder.

## Scope

**In scope:**

- The four-step cascade applied to every call: caller-supplied native title, producer-specific native reader, first-user-message fallback, constant placeholder.
- The second public entry point: the same cascade applied to an archived conversation slice at memory-write time, its swallow-everything failure contract, and its absent-instead-of-placeholder result.
- The branch that runs the producer-specific native reader only for sessions whose producer is the one producer that has a native reader.
- The producer-specific native reader's size budget: whole-file scan below it, tail scan above it, and the discarded first line of a tail read.
- The branch that, when the caller passes a pre-loaded merged-entry array, derives the fallback from that array instead of streaming the transcript again from disk.
- The per-producer line parsers that the first-user-message fallback consults, including the rule that some producers always return "no match" because their sessions always carry a native title.
- The two stringification shapes the parsers accept for a user-message body (bare string, array of mixed string/object blocks) and what they reject.
- The code-point truncation rule applied to every non-placeholder output.
- The whitespace normalization rule embedded in the truncation step.
- The set of failures that fall through to the next step in the cascade vs. the failures that abort the cascade and return the placeholder.
- The default-producer rule that applies when the session record does not carry a producer field.

**Out of scope (boundaries):**

- How the active-session aggregator decides to call the resolver, how it parallelizes the calls across sessions, what surface renders the resolved title, and the cost-saving rule by which the aggregator passes in a pre-loaded merged-entry array — owned by the active session aggregator spec.
- How each producer's transcript is discovered, located on disk, and loaded into the merged-entry shape consumed elsewhere — owned by the per-producer transcript reading specs.
- The persistence and emission rules for any "native title" field on a discoverer's session record — owned by each producer's discovery spec; the resolver only consumes the field if present.
- Where the archived title the second entry point produces is *stored* on a memory's transcript artifact, which writers call it, and the order in which later readers prefer it over other sources — owned by the memory-storage and read-model topics. This spec defines only how that value is computed and the fact that it can legitimately be absent.
- The placement of any cache or memoization across multiple calls; the resolver itself is stateless and recomputes on every call. Any caching that exists lives in the caller — and the one caller that had a cache no longer exists: the local dashboard's memory-detail read used to hand each conversation row a live transcript path so a later asynchronous pass could re-derive the native title, keyed by that file's modification time and size. That read and its cache are gone, and the read model it belonged to is now synchronous, so nothing on a request path calls this resolver.
- The mechanism that triggers refresh of a title in any user-facing surface; the resolver runs once per call and does not subscribe to any event.

## Data Contracts

### Input

The resolver takes a session record and an optional pre-loaded entry array.

| Field                       | Type                  | Meaning                                                                                                              |
| --------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------- |
| session identifier          | string                | Opaque producer-supplied session identifier. Used for diagnostics only.                                              |
| transcript handle           | opaque locator        | Producer-supplied locator the resolver passes to readers that consume the underlying transcript stream.              |
| native title (optional)     | string or absent      | Already-resolved title the discoverer attached to the session record. Empty string and absent both mean "no native". |
| producer (optional)         | producer enum or absent | Which producer produced this session. When absent, the resolver substitutes the default producer (see below).      |
| pre-loaded entries (optional) | merged-entry array  | When supplied, the fallback step extracts the first-human-turn body from this array instead of re-reading from disk. |

A merged entry carries a role (one of "human" or "assistant") and a content string. The resolver inspects only the role and content fields.

### Producer enumeration

The resolver pins a closed enumeration of producers, and its per-producer parser table is total over it. The producers are named, in this spec, by their shorthand identifiers: **claude**, **codex**, **gemini**, **opencode**, **cursor**, **cursor-cli**, **copilot**, **copilot-chat**, **cline**, **cline-cli**, **devin**, **antigravity**, **kimi**. When the session record's producer field is absent, the resolver substitutes **claude**.

### Output

A single string. Always non-empty. Either:

- A title derived from one of the cascade steps, post-truncation and post-normalization, OR
- The constant placeholder. The exact wording is **`(untitled session)`** (literal including the parentheses).

### Truncation contract

The truncation function takes an arbitrary string and produces a string with these properties:

- Length is at most **60 Unicode code points**. Truncation iterates by code point (not by UTF-16 code unit), so surrogate pairs and combined emoji sequences are preserved at the cut.
- Internal runs of whitespace (any run of one or more whitespace characters) are collapsed to a single space character.
- Leading and trailing whitespace is stripped.

The truncation function is applied before output to every non-placeholder cascade step result.

### Stringification contract for body extraction

The per-producer parsers extract a "user message body" from a parsed JSON object. The body candidate may be a bare string or an array. Stringification rules:

- A bare string is returned verbatim.
- An array is iterated element by element: each bare-string element contributes itself; each object element contributes its `text` field if that field is a string; any other element shape (number, boolean, object without a string `text`, null) is skipped. The kept parts are joined with single space characters. An array that contributes zero parts yields **undefined** (signaling "no extractable body").
- Any other shape (number, plain object, undefined) yields **undefined**.

## Behavior

### Top-level cascade

The resolver applies these steps in order; the first step that produces a non-empty string wins. Each step's output is passed through the truncation contract before being returned.

**Step 1 — Caller-supplied native title.** If the session record carries a native title that is a string and whose trimmed length is greater than zero, return the truncated native title. The producer-specific reader and the fallback are not invoked.

**Step 2 — Producer-specific native reader.** Applies only when BOTH conditions hold: (a) the resolved producer (the record's producer field, with **claude** substituted on absence) is **claude**, AND (b) the session record carries a non-empty transcript handle. When the producer is not claude, or the transcript handle is empty (e.g. an archived session whose live transcript is gone), this step is skipped and the cascade proceeds to step 3. The empty-handle skip is deliberate: opening a read stream on an empty handle is a real filesystem round-trip that always fails with not-found, so the read is a guaranteed miss and pure waste.

When the step applies, the resolver invokes the Claude native reader (see "Claude native reader" below). The reader either returns a non-empty string, returns undefined, or throws. On a non-empty string return, the resolver returns the truncated string. On undefined, the cascade proceeds to step 3. On a thrown error, the resolver records a diagnostic and proceeds to step 3 (the reader is supposed to swallow its own I/O errors, so reaching this branch indicates an unexpected internal failure and is logged at a debug level rather than silently swallowed).

**Step 3 — First-user-message fallback.** Two sub-paths:

- **Pre-loaded entries path.** When the caller supplied a merged-entry array, the resolver scans the array in order, skipping entries whose role is not "human" and skipping entries whose content's trimmed length is zero. The first surviving entry's content is truncated and returned. If no surviving entry exists, the placeholder is returned (this is the terminal return for this sub-path; step 4 is not executed because step 3 has produced a final answer for this branch).
- **Streaming path.** When the caller did not supply a merged-entry array, the resolver invokes the streaming fallback (see "Streaming first-user-message fallback" below) parameterized by the per-producer line parser for the resolved producer. The streaming fallback returns either a non-empty truncated title or the placeholder. The resolver returns whatever the streaming fallback returns. If the streaming fallback itself throws (i.e. its internal error handling let an exception escape), the resolver records a diagnostic and returns the placeholder.

**Step 4 — Placeholder.** This step is the constant fallback for paths that did not produce a result above. It is the placeholder string, returned as-is (no truncation applies; the placeholder is below the code-point limit by construction).

### Claude native reader

The reader streams the session transcript line by line and remembers the most recent line that matches a "native title" record shape. At end of stream, the reader returns the remembered payload, or undefined if no line matched.

**The scan does not always start at the beginning of the file.** The reader stats the transcript first and compares its size against a **four-mebibyte** budget:

- At or below the budget, the whole file is read, exactly as described above.
- Above it, the scan starts that many bytes from the **end** of the file. Everything before that offset is never read.
- A failed stat falls through to a whole-file scan. The size is an optimisation input, not a precondition, and the stream reports the real error a moment later anyway.

The tail is sound because of what this record *is*: the producer re-emits it as the conversation continues and only the **last** one is wanted, so the answer lives at the end of the file and every line before it is read only to be thrown away.

**The first line of a tail read is discarded.** A byte offset lands mid-line (and possibly mid-code-point) in the general case, so that line is a fragment. It cannot be parsed — and, the load-bearing half, a fragment of a **non-title** line can carry a title record's shape and pass the substring filter below. Dropping it costs one line and is the only way to keep every line the loop sees a whole one. The drop applies only when the scan started past byte zero.

**What the budget gives up, and it is undocumented anywhere the user can see:** a transcript that grew past the budget with *every* title record behind the cut yields no candidate at all. The reader returns "no title", the cascade falls through to the next step, and the session is titled from its first user message instead. That is a silent downgrade rather than a wrong title, which is the trade — but nothing reports it, and no log line distinguishes it from a transcript that genuinely never carried a title record.

- Each line is first filtered by a fast literal-substring check: the line must contain the exact substring `"type":"ai-title"` (including the closing double-quote after the value). Lines that fail this filter are skipped without parsing.
- Lines that pass the filter are parsed as JSON. Lines whose parse fails are counted (the count is logged once at end of stream at a debug level) and skipped; the scan continues so a later valid line still wins.
- A parsed object contributes a candidate when its `aiTitle` field is a non-empty string. The producer continuously appends one such row every time it re-evaluates the session title, and the most recent one is canonical.
- Notably, there is no explicit post-parse check that the `type` field equals the expected string. The pre-filter is exact enough that any line passing the filter has a `type` that matches; relying solely on the substring filter is intentional and the post-parse `type` check is redundant. Lines whose `type` is close-but-not-equal (e.g. a longer string that starts with the expected value) cannot pass the pre-filter because the filter requires the trailing quote.
- File-not-found is silent: the reader returns undefined without logging. Any other failure on the stream (permission denied, path is a directory, transient I/O error) is logged at a debug level and the reader returns undefined.

### Streaming first-user-message fallback

The streaming fallback takes a transcript handle and a per-producer line-parser function. It produces either a non-empty truncated title or the placeholder.

The fallback opens the transcript and reads it line by line:

- Empty lines (zero-length after newline split) are skipped before reaching the parser.
- Each non-empty line is handed to the per-producer parser. If the parser throws, the line is skipped and the scan continues.
- If the parser returns a string whose trimmed length is greater than zero, the fallback runs that string through the truncation contract and returns the result. The post-truncation result cannot be the empty string for a parser body that had at least one non-whitespace code point: truncation slices the first sixty code points, and the body has at least one such code point by the trim-length check.
- If the parser returns undefined or an empty/whitespace-only string, the scan continues to the next line.
- If the scan reaches end of stream without returning, the fallback returns the placeholder.

Failure handling:

- File-not-found is silent: the fallback returns the placeholder without logging.
- Any other failure on the stream is logged at a debug level and the fallback returns the placeholder.

### Per-producer line parsers

Each producer supplies one parser. Each parser receives one transcript line as a string. It must:

1. Attempt to parse the line as JSON. If parsing fails or the parsed value is not a non-null object, return undefined.
2. Inspect the parsed object's shape against the producer's match rule. If the rule does not match, return undefined.
3. Extract the body via the stringification contract. If extraction yields undefined, return undefined.
4. Otherwise, return the extracted string.

The parsers, by producer:

| Producer       | Match rule                                                                                                                | Body extraction                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **claude**     | Object's `type` field equals `"user"`.                                                                                   | Try `message.content` first; if that field is absent, try the top-level `content`. Apply the stringification contract.                                         |
| **codex**      | Object's `role` field equals `"user"`.                                                                                   | Top-level `content`. Apply the stringification contract.                                                                                                       |
| **gemini**     | Object's `type` field equals `"user"`. (Notably, **not** `role` — Gemini transcripts mark user turns with `type`, not `role`.) | Try the top-level `content` via the stringification contract first; if that yields undefined, accept a top-level `text` field as a final fallback when it is a string. |
| **opencode**   | Always returns undefined.                                                                                                | Opencode sessions always carry a native title from the discoverer; this parser exists for completeness only.                                                   |
| **cursor**     | Always returns undefined.                                                                                                | Same as opencode.                                                                                                                                              |
| **copilot**    | Always returns undefined.                                                                                                | Same as opencode.                                                                                                                                              |
| **copilot-chat** | Two on-disk shapes accepted; see below.                                                                                | Shape-specific.                                                                                                                                                |
| **cursor-cli**   | Always returns undefined.                                                                                                | The source carries a native title from the discoverer; this parser exists for completeness only (stub).                                                       |
| **cline**        | Always returns undefined.                                                                                                | The source carries a native title from the discoverer; this parser exists for completeness only (stub).                                                       |
| **cline-cli**    | Always returns undefined.                                                                                                | The source carries a native title from the discoverer; this parser exists for completeness only (stub).                                                       |
| **devin**        | Always returns undefined.                                                                                                | The source carries a native title from the discoverer; this parser exists for completeness only (stub).                                                       |
| **antigravity**  | Always returns undefined.                                                                                                | The source carries a native title from the discoverer; this parser exists for completeness only (stub).                                                       |
| **kimi**         | Object's `type` field equals the prompt-turn marker. (Notably **not** `role` and **not** `type: "user"` — this producer's wire stream types a human turn as a prompt-turn event.) | Top-level `input`. Apply the stringification contract.                                                                                                        |

**Copilot-chat parser** handles two shapes within one parser:

- **Shape A.** Object has a `value` field that is a non-null object. Within `value`: if `value.message.text` is a string, return it directly without stringification. Otherwise, apply the stringification contract to `value.content`; if it yields a string, return it.
- **Shape B.** Object's `type` field equals `"user.message"` and its `data` field is a non-null object. Apply the stringification contract to `data.content`; if it yields a string, return it.
- If neither shape produces a value, return undefined.

Note: a line that matches shape A but contributes no string still falls through to shape B's check. A line that matches neither shape falls through to "return undefined".

### Pre-loaded-entries shortcut behavior

When the caller passes a pre-loaded merged-entry array, step 3's pre-loaded sub-path applies:

- The resolver iterates the array in index order.
- Entries whose role is not "human" are skipped.
- Entries whose content's trimmed length is zero are skipped.
- The first surviving entry's content is truncated and returned.
- An empty input array, or an array with no surviving entries, returns the placeholder.

This sub-path does not consult disk and does not invoke the per-producer line parser. The producer is irrelevant once the merged-entry array is in hand; the entries are already producer-normalized into the merged shape.

The Claude native reader still runs in step 2 even when pre-loaded entries are supplied — provided the session carries a non-empty transcript handle — because the merged-entry array does not contain the native-title rows (those rows are stripped during transcript loading). When the transcript handle is empty, step 2 is skipped regardless of whether entries were supplied, and the cascade falls through to step 3.

### The archived-slice entry point

A second public entry point resolves the title to **store with a session** at the moment a memory is written, rather than the title to display right now. It takes a slice of an archived conversation — a session identifier, an optional producer, an optional transcript handle, and the array of entries that slice owns — and runs the identical cascade over it. Three things about it differ:

- **The entries it passes are the archived slice, not the live file.** So step 3 describes the turns this memory actually owns; for an amend or squash chain the live file's first turn belongs to a different commit, and using it would title every slice of the chain identically.
- **It never propagates a failure.** Every error is caught, recorded as a diagnostic, and answered as "absent". The display cascade already never propagates one, so this is a second net rather than the first — a title is never worth failing an archive write for, and the archive itself is what must land.
- **It answers absent in place of the placeholder.** When the cascade returns the constant placeholder, the entry point returns nothing at all, so the stored field stays absent rather than carrying the placeholder string. "No title" is a fact each later reader renders its own way, and an absent field is also what lets a reader fall back the same way it does for an archive written before the field existed.

An absent transcript handle is substituted with the empty string, which by the step-2 empty-handle rule skips the producer-specific native reader. So a slice archived with no live file behind it resolves from its own entries or not at all. When the handle *is* present, step 2 still runs against the live file for the one producer that has a native reader — the same reason it runs in the display path, since the archived entries never contain the native-title records.

Every reader of a stored title used to re-derive it independently, and each derived it differently. Resolving it once at write time is what makes them agree by construction — and commit time is the only moment where it is both cheap and correct, because the live transcript was just read and is the argument to this call.

### Diagnostic recording

The resolver logs diagnostics at a debug level in two cases:

- The Claude native reader (step 2) threw an exception. The diagnostic includes the transcript handle and an error message.
- The streaming first-user-message fallback (step 3, streaming sub-path) threw an exception that its own catch did not handle. The diagnostic includes the producer, the transcript handle, and an error message.
- The archived-slice entry point caught anything at all. The diagnostic includes the session identifier and an error message, and the entry point answers "absent".

The two underlying readers also emit their own debug-level diagnostics for non-ENOENT stream failures and (for the Claude reader) for the count of malformed lines that passed the substring filter.

No diagnostic surfaces in the returned value; on any of these conditions, the resolver's contract is to fall through to a later step or to the placeholder.

## State Transitions

The resolver is stateless. It mutates nothing on disk, retains nothing across calls, and starts no background work. Each call is a fresh end-to-end traversal of the cascade above.

Both underlying readers open the transcript on each call and close it, and neither memoizes across calls. They differ in how much of it they read: the streaming first-user-message fallback always opens at byte zero and streams to completion (it stops early only on a hit); the Claude native reader streams to completion but starts four mebibytes from the end for any transcript larger than that, so above the budget it never reads the file's opening bytes at all.

## Notable Behavior

- **Step 2 only applies to one producer, and only with a non-empty transcript handle.** Other producers always skip directly from step 1 to step 3. Even for that one producer, step 2 is skipped when the session's transcript handle is empty (an archived session whose live transcript is gone), because opening a stream on an empty handle would be a guaranteed not-found read. The native-reader step is not generic; it is a hardcoded special case for the one producer that emits dedicated native-title rows into its transcript.

- **Step 2 still runs when pre-loaded entries are supplied.** This is intentional. The merged-entry array consumed by step 3's pre-loaded sub-path has already had the native-title rows stripped by the transcript loader, so step 2 must do its own independent stream against the raw transcript on disk. Skipping step 2 because pre-loaded entries were supplied would silently lose Claude's native title for callers that pass in entries. (Step 2 still requires a non-empty transcript handle; a pre-loaded caller whose session has an empty handle skips step 2 for that reason, not because entries were supplied.)

- **Pre-loaded sub-path terminates the cascade.** When the caller passes a merged-entry array, step 3 either returns a hit from the array or returns the placeholder. The streaming sub-path is not consulted and step 4 is not reached separately; the placeholder return inside step 3 is the cascade's terminal return for this branch.

- **Native title bypasses both readers.** A non-empty native title in the session record causes the resolver to return without ever opening the transcript or invoking the producer-specific reader. This is the cheap path the resolver advertises for producers whose discoverer already has the title (e.g. from a database column).

- **Gemini parser is a deliberate correction.** Gemini transcripts mark user turns with `type: "user"`, not `role: "user"`. An earlier implementation checked `role`, with the effect that every Gemini session fell through to the placeholder even when the transcript clearly had user turns. The parser also reads `text` defensively as a top-level fallback for any future Gemini schema variant that promotes a top-level text key.

- **Copilot-chat parser handles two shapes inside one parser.** Real Copilot Chat transcripts come in two on-disk shapes: a per-session JSONL patch document and an events.jsonl envelope. An earlier implementation handled only shape A, with the effect that events.jsonl-backed sessions rendered correctly in the detail panel (the loader supports both shapes) but always showed the placeholder in the sidebar title. The parser handles both shapes precisely to remove that "details work, title is wrong" split.

- **Opencode, cursor, copilot, cursor-cli, cline, cline-cli, devin, antigravity parsers are no-op stubs.** These producers' discoverers always populate the native title field, so step 1 wins for every real session. The stub parsers exist so the per-producer parser table is total over the producer enum. If a session of one of these producers ever reaches step 3 (because the native title was unexpectedly empty), the parser unconditionally returns undefined and the placeholder is emitted.

- **The kimi parser is a real parser, not one of those stubs, and it is genuinely reached.** That producer's discoverer populates the native title only when the session's own metadata document carried a non-empty one, and it omits the field entirely otherwise — so a session whose metadata is silent about the title falls through step 1 into step 3, where this parser recognises the transcript's prompt-turn event and returns its stringified body. The parsers that actually inspect a line are claude, codex, gemini, copilot-chat and kimi; every other entry in the table is a stub.

- **Pre-filter substring check in the Claude reader is sound.** The reader explicitly does not re-check the `type` field after JSON parsing. The literal substring `"type":"ai-title"` (with the trailing closing quote) is exact: any line that passes this check has, after parsing, a `type` that is exactly `"ai-title"`. A line whose `type` is a longer string that starts with the same value (e.g. `"ai-title-other"`) does not pass the pre-filter because the closing quote position would be different.

- **A large transcript's native title can be lost silently, and no surface says so.** Above the four-mebibyte budget the reader sees only the tail, so a transcript whose every title record sits before the cut yields no candidate and the session is titled from its first user message instead. Nothing distinguishes that outcome from a transcript that never carried a title record: the reader logs neither case, and the cascade's own contract is to fall through. The design accepts it because a fall-through is a downgrade while reading a stale mid-file record would be a wrong answer — but the failure mode is real and unreported. (Surprising; deliberate, undocumented to the user.)

- **The tail read throws away its own first line, and the reason is not truncation but forgery.** A byte offset lands mid-line, so that line is a fragment — and a fragment of a line that is *not* a title record can still contain the exact substring the pre-filter tests for. Keeping it would let an arbitrary line's tail be parsed as a title record. Dropping it is what makes the pre-filter's soundness argument hold for a tail read at all. (Surprising.)

- **The archived-slice entry point returns absent where the display cascade returns the placeholder**, and that difference is the whole point of it: the stored field must be able to be missing, because a reader that finds it missing falls back, while a reader that finds the placeholder string renders it. The same entry point also swallows every error rather than propagating one, so an archive write can never fail over a title. (Notable.)

- **Lines that pass the Claude pre-filter but fail JSON.parse are counted, not aborted on.** The reader continues scanning so that a later valid line still wins. The count is logged once at end of stream at a debug level rather than per line, because title resolution is cosmetic and per-line warnings would be noise.

- **Truncation to zero code points returns an empty string.** This is a property of the truncation contract that is not exercised in production (the production limit is 60), but the streaming fallback defends against it by treating an empty truncation result as "no body extracted" and continuing the scan. The pre-loaded sub-path applies truncation without this guard; with the production limit of 60, the truncation of a non-trimmed body cannot return empty.

- **Code-point truncation, not UTF-16 truncation.** The 60-character limit counts Unicode code points. A body composed of 30 astral-plane emoji (each one code point but two UTF-16 code units) is preserved in full. A naive UTF-16 truncation at 60 code units would split the 31st emoji's surrogate pair.

- **Whitespace normalization is global.** The truncation contract collapses every run of whitespace to a single space and trims leading/trailing whitespace. A body of `"  hello\n\n  world  "` truncates to `"hello world"`.

- **Empty array of pre-loaded entries vs. all-non-human entries vs. all-whitespace bodies.** All three return the placeholder via the same code path: the scan exits without finding a surviving entry.

- **Malformed JSON lines never crash the cascade.** Each parser catches its own JSON failures and returns undefined; the streaming fallback catches parser-thrown exceptions and continues; the Claude reader catches its own parse failures and continues. The cascade can only return the placeholder via a "no source matched" path, never via an uncaught exception in a parser.

- **The two underlying readers have different failure-isolation contracts.** The Claude native reader is documented as swallowing its own I/O errors; when its outer catch is entered in step 2, that is a signal of an unexpected internal failure and is logged. The streaming fallback's outer catch is the normal path for non-ENOENT failures and returns the placeholder. Either way, the resolver as a whole never propagates an exception to its caller.

## Shared Behavior

- **Active session aggregator (spec 155):** is the canonical caller. The aggregator owns the cost-saving rule that passes a pre-loaded merged-entry array into the resolver and the orchestration that issues one resolver call per row in parallel. The aggregator's title-cascade contract is a contract on this resolver; this spec is the canonical definition of that contract.
- **Per-producer transcript reading specs (16, 17, 18, 19, 20, 21, 22):** define how each producer's transcript is discovered, located on disk, and loaded into the merged-entry shape that the pre-loaded sub-path consumes. They also define the on-disk record shapes that the per-producer line parsers recognize. The resolver consumes whatever shapes those specs document; if the on-disk shape evolves, the corresponding parser in this spec evolves with it.
