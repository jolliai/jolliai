# 182. Session Title Resolution Chain

## Topic Statement

A single call resolves the display title for one AI coding session by consulting an ordered chain of sources, returning a constant placeholder when no source yields a non-empty string.

## Scope

**In scope:**

- The four-step cascade applied to every call: caller-supplied native title, producer-specific native reader, first-user-message fallback, constant placeholder.
- The branch that runs the producer-specific native reader only for sessions whose producer is the one producer that has a native reader.
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
- The placement of any cache or memoization across multiple calls; the resolver itself is stateless and recomputes on every call. Any caching that exists lives in the caller.
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

### Diagnostic recording

The resolver logs diagnostics at a debug level in two cases:

- The Claude native reader (step 2) threw an exception. The diagnostic includes the transcript handle and an error message.
- The streaming first-user-message fallback (step 3, streaming sub-path) threw an exception that its own catch did not handle. The diagnostic includes the producer, the transcript handle, and an error message.

The two underlying readers also emit their own debug-level diagnostics for non-ENOENT stream failures and (for the Claude reader) for the count of malformed lines that passed the substring filter.

No diagnostic surfaces in the returned value; on any of these conditions, the resolver's contract is to fall through to a later step or to the placeholder.

## State Transitions

The resolver is stateless. It mutates nothing on disk, retains nothing across calls, and starts no background work. Each call is a fresh end-to-end traversal of the cascade above.

The Claude native reader and the streaming first-user-message fallback both open the transcript on each call, stream it to completion, and close it. They do not memoize across calls.

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
