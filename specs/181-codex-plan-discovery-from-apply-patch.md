# 181. Codex Plan Discovery from Apply-Patch

## Topic Statement

Scan a Codex agent's append-only transcript for patch-application requests that target a markdown file, then feed each resolved absolute markdown path into the shared, source-agnostic plan upsert.

## Scope

**In scope:**

- The transcript-line shape that this scanner accepts as a patch-application request.
- The patch-body header lines that produce a candidate target path.
- The header lines that are intentionally ignored.
- How a target path is extracted from a header line, including whitespace and case handling.
- Resolution of a target path to an absolute path against the agent's working directory.
- The accumulated outputs of one scan call — the set of absolute markdown paths, the (always empty) slug set, and the total line count consumed.
- The line-range window (lower bound exclusive, upper bound inclusive, default open at the top) and its early-stop behavior.
- Malformed-input tolerance so a corrupt line never aborts the scan.
- The hand-off across the boundary into the shared driver (what the driver receives and how it deduplicates).
- The cap that the upstream polling tick applies to the upper bound so that no patch line is interpreted twice.

**Out of scope (boundaries):**

- How the upstream polling tick discovers Codex sessions, picks transcript paths, or schedules scans (covered by the Codex polling-tick spec).
- How the polling tick computes the safe upper-bound line that it passes in as the cap (covered by the Codex polling-tick spec).
- The persisted cursor used to remember "how far has this transcript been scanned" — the scanner is stateless about cursors; the polling tick owns persistence.
- The reference-discovery scan that runs alongside plan discovery in the same polling tick.
- The shared upsert behavior consumed across all transcript sources: archive-guard re-arming, slug-collision resolution by hashing the normalized absolute path, the on-disk existence gate that decides whether a candidate becomes a registry record, the external-plan exclusion list of segments and basenames, the concurrent-merge / per-slug overlay of touched entries, and the cross-mutation safety against notes that already own a given file. These are described by the shared transcript-plan-discovery spec (the Claude-side spec) and are referenced from here without restating them.
- Slug-keyed canonical plan files under the user-home plans directory (Codex has no such directory; the scanner always emits an empty slug set).
- The transcript file's own outer JSONL grammar beyond the per-line shape this scanner cares about.
- The remote push / archival of a discovered plan into a stored summary or remote document.

## Data Contracts

### Inputs

- **Transcript path** — an absolute path to an append-only newline-delimited JSON file (one event per line) produced by the Codex agent.
- **Working directory** — an absolute path that names the project root the agent is operating in. Used to resolve relative target paths.
- **From-line watermark** — a non-negative integer. Lines whose 1-based number is less than or equal to this value are counted but not interpreted. A value of zero means "scan from the first line".
- **To-line cap** (optional) — a non-negative integer. Lines whose 1-based number exceeds this value are not interpreted, and the scanner stops reading the stream as soon as the first out-of-range line is seen. The default is "unbounded" (positive infinity).
- **Source tag** — a fixed label identifying the transcript source. This scanner is selected when the tag is the Codex tag; unknown tags fall back to a different scanner and so do not exercise this path.

### Recognized line envelope

A transcript line is treated as a patch-application request only when, after parsing it as JSON, all of the following hold:

- The top-level value is a JSON object.
- It has an object-valued `payload` field.
- The payload's `type` field is the string `custom_tool_call`.
- The payload's `name` field is the string `apply_patch`.
- The payload's `input` field is a string. That string is the raw patch text and must contain real newlines as produced by parsing the JSON line; no further unescaping is performed.

A line whose top-level JSON value is not an object, whose `payload` is not an object, whose `payload.type` is anything other than the literal above, whose `payload.name` is anything other than the literal above, or whose `payload.input` is not a string, is silently ignored. In particular: a function-call entry whose name happens to be `apply_patch` (rather than a custom-tool-call entry) is **not** recognized; a custom-tool-call entry whose name is anything other than `apply_patch` is **not** recognized; a shell-style invocation whose arguments merely mention `apply_patch` is **not** recognized.

### Recognized patch-body header lines

Inside the patch text (the value of `payload.input`), the scanner walks every line separated by `\n` and matches lines that **start at column zero** with one of three exact ASCII prefixes:

- `*** Add File:` — the colon-suffix is a target path to add.
- `*** Update File:` — the colon-suffix is a target path to update.
- `*** Move to:` — the colon-suffix is the rename destination inside an update block.

Any other header — notably `*** Delete File:`, `*** Begin Patch`, `*** End Patch`, hunk markers (`@@…`), or any other line — produces no candidate.

### Column-zero requirement

The match against a prefix is performed on the **raw, un-trimmed** patch line. A line with any leading whitespace (for example, a hunk context line whose first character is a single space) is not a header even if its remainder reads exactly like one. This is necessary because patch context lines for markdown documents can themselves contain header look-alikes verbatim. By the same construction, lines beginning with `+` or `-` (added or removed body lines inside a hunk) are not headers.

### Path extraction

Once a header prefix is matched, the **entire** remainder of the line (everything after the matched prefix) is the candidate path. Leading and trailing whitespace on that remainder is stripped (this also removes a trailing carriage return left by a CRLF line terminator). The path is **not** split on whitespace — it may legitimately contain spaces, and the full segment after the colon is taken verbatim.

If the resulting segment is empty (a header followed by only whitespace), the line produces no candidate.

### Markdown filter

The trimmed path is accepted only if its suffix (compared case-insensitively) is `.md`. Targets whose extension is anything else are dropped. The comparison is purely lexical on the lowercased trailing five characters; there is no examination of file contents or MIME inference.

### Path resolution

The accepted markdown path is resolved against the working-directory input using standard absolute-path resolution rules: a relative path becomes the working directory joined with that relative path; an already-absolute path passes through unchanged.

### Outputs

A single result value containing:

- **Slug set** — always empty for this scanner. Codex has no canonical user-home plan directory and produces no slug signals.
- **External-plans set** — the set of absolute markdown paths gathered across every recognized header line in every recognized envelope line in the window. The set is unordered and deduplicates trivially equal absolute paths (no normalization beyond the resolver's own normalization).
- **Total lines** — the 1-based line number of the **last line read from the stream**. When the upper bound triggers an early stop, this is the line number of the **first out-of-range line reached** (the cap value plus one), not the cap itself. When the stream is read to end-of-file, this is the total line count of the file.

### Boundary into the shared upsert driver

The shared driver receives the source tag, the working directory, the lower and upper line bounds, and the transcript path. It calls this scanner with those, then takes the three returned values and:

- Applies the shared external-plan exclusion policy (path-segment denylist including the agent-private directories, plus a basename denylist of common non-plan markdown files) to the external-plans set. The slug set is untouched (it is empty for Codex). This policy is owned by the driver, not by this scanner.
- Requires every survivor to exist on disk at scan time; survivors whose file is absent are silently dropped. This is the **only** success gate. Because this scanner reads the patch request, not the patch result, it cannot tell whether the patch actually applied; the file-existence check is the deliberate stand-in for "did the write land". A failed or undone add leaves no file and is dropped. A failed or undone update against a pre-existing markdown file leaves the file in place and is therefore upserted — this is an accepted benign true-ish positive that mirrors the shared Claude behavior.
- Suppresses any survivor whose normalized absolute path matches a registered note's source path (notes win over plan auto-registration).
- Derives a base slug from the file's basename minus the `.md` suffix (case-insensitive), then assigns a unique slug for that path: if any existing registry entry already has this exact absolute path as its source path, that entry's slug is reused; otherwise if the base slug is free, the base slug is used; otherwise the base slug is suffixed with the first eight hex characters of a hash of the normalized absolute path.
- Upserts each survivor into the project's plans registry under a lock, layering only the slugs this scan touched onto a fresh re-read of the registry so that concurrent writers (the commit pipeline, a parallel discovery tick, the editor extension) are preserved.

The total-lines value is returned upward to the polling tick and is **not** used by the scanner as a cursor. The polling tick uses a separate "reference-safe" line as its persisted cursor and passes that line as the upper-bound cap on the next call, ensuring that no patch line is ever interpreted twice.

## Behavior

### Execution order

1. Open the transcript file as a UTF-8 stream and overlay a line reader with infinite carriage-return delay (so a `\r\n` terminator counts as one line, not two).
2. Initialize the line counter to zero, the slug set to empty, and the external-plans set to empty.
3. For each line yielded by the reader:
   1. Increment the line counter.
   2. If the new counter is less than or equal to the lower-bound watermark, return to the loop (count but skip).
   3. If the new counter is greater than the upper-bound cap, **close the line reader and destroy the underlying stream**, then return to the loop (the close ends iteration). The counter retains the out-of-range value; this becomes the reported total-lines.
   4. If the raw line does not contain the substring `apply_patch`, return to the loop (cheap pre-filter that avoids JSON-parsing irrelevant lines).
   5. Attempt to parse the line as JSON. If parsing throws, return to the loop (malformed line, never propagated).
   6. If the parsed value is not a non-array object, return to the loop.
   7. If the object's `payload` value is not a non-array object, return to the loop.
   8. If `payload.type` is not the literal `custom_tool_call`, return to the loop.
   9. If `payload.name` is not the literal `apply_patch`, return to the loop.
   10. If `payload.input` is not a string, return to the loop.
   11. Split the `payload.input` string on the literal newline character. For each resulting raw patch line:
       1. Test the raw patch line against each of the three target-producing prefixes in order. The first prefix that matches at position zero wins. If none match, continue to the next patch line.
       2. Slice the patch line from immediately after the matched prefix to the end, then trim outer whitespace. If the remainder is empty, continue to the next patch line.
       3. If the remainder, lowercased at its tail, does not end in `.md`, continue to the next patch line.
       4. Resolve the remainder against the working-directory input to an absolute path and add it to the external-plans set.
4. When the line reader signals close (end-of-file, early stop, or a stream error), resolve the result with the slug set (empty), the external-plans set, and the final value of the line counter.

### Branches

- **From-line covers the entire file** → counter equals every line read but no line is interpreted; the result has an empty slug set, an empty external-plans set, and a total-lines value equal to the file's line count.
- **To-line cap below from-line watermark** → no line is interpreted; the stream is destroyed after reading the first line whose counter exceeds the cap; total-lines is that out-of-range line number.
- **To-line cap is the default unbounded** → the scanner reads to end-of-file; total-lines is the file's line count.
- **A recognized envelope line whose patch contains no recognized header** → no candidate is produced for that line.
- **A recognized envelope line whose patch contains multiple recognized headers** → every recognized header is evaluated; each accepted markdown path joins the set.
- **A recognized envelope line whose only recognized headers all target non-markdown paths** → no candidate joins the set.
- **A `Delete File:` header alongside other headers** → the delete is ignored; the other headers are evaluated normally.
- **A `Move to:` header inside a non-markdown update block** → the `Move to:` destination is still evaluated against the markdown filter; if the destination is markdown, it joins the set even though the update source is not markdown.
- **A `Move to:` header inside a markdown update block** → both the update-source markdown path and the move-destination markdown path are emitted by the scanner. The on-disk existence gate in the shared upsert driver decides which one survives; on a successful rename, only the destination still exists, so only the destination is upserted. (Intentional: the scanner does not try to model the patch's effect; the driver's existence gate is the authority.)
- **A header line whose remainder is whitespace only** → no candidate joins the set.
- **A header line with a trailing CRLF** → the carriage return is trimmed; the remainder is the bare path.
- **A header line whose remainder is an already-absolute path** → the resolver leaves it unchanged.
- **A header line whose remainder contains spaces** → the entire segment after the colon, with outer whitespace trimmed, is the path; internal spaces are preserved.
- **A header line whose extension casing is mixed** (e.g. `.MD`, `.Md`) → accepted; the case-insensitive `.md` filter admits it.
- **An indented header look-alike** (any leading whitespace) → not a header; ignored.
- **A `+` or `-` body line that is otherwise the literal text of a header** → not a header; ignored.
- **A function-call entry whose name is `apply_patch`** → not a recognized envelope (wrong `payload.type`); ignored.
- **A custom-tool-call entry whose name is anything but `apply_patch`** → not a recognized envelope; ignored.
- **A shell-style invocation whose arguments mention `apply_patch`** → not a recognized envelope (wrong `payload.type` and wrong `payload.name`); ignored.
- **A line that is not JSON at all but contains the substring `apply_patch`** → passes the pre-filter, fails JSON parsing, is silently dropped.
- **A line whose `payload` is a string rather than an object, where the string contains `apply_patch`** → passes the pre-filter, fails the object check, is silently dropped.
- **A recognized envelope whose `input` is a number or is absent** → silently dropped.

### Error classification

| Class | Trigger | Outcome |
| --- | --- | --- |
| Malformed JSON line | A line passes the substring pre-filter but cannot be parsed as JSON. | Silently skipped; scan continues with the next line. |
| Non-object top-level | A line parses as JSON but the top-level value is null, an array, a primitive, or a non-object. | Silently skipped. |
| Non-object payload | A line parses but its `payload` is null, an array, a primitive, or anything other than a plain object. | Silently skipped. |
| Wrong envelope tag | `payload.type` is not `custom_tool_call` or `payload.name` is not `apply_patch`. | Silently skipped. |
| Wrong `input` type | `payload.input` is missing, null, a number, or any non-string. | Silently skipped. |
| Stream read error | The underlying file stream emits an error mid-scan. | The scan resolves with whatever was accumulated so far; the line counter holds the count of lines fully read before the error. |
| Out-of-range line | A line's counter exceeds the upper-bound cap. | The line reader is closed and the underlying stream is destroyed; the scan resolves with whatever was accumulated and with the counter holding the first out-of-range line number. |
| Empty patch path | A recognized header line has only whitespace after the colon. | The header produces no candidate; the scan continues. |
| Non-markdown patch path | A recognized header line's path does not end in `.md` (case-insensitive). | The header produces no candidate; the scan continues. |

### Side effects

- One streamed read of the transcript file. No file is written by this scanner.
- No on-disk lookup of the markdown target paths themselves — existence checking happens later in the shared upsert driver.
- No source-control operations.
- No network operations.
- No model calls.

## State Transitions

This scanner is stateless across calls. A single call's externally visible state changes are:

- **Empty result → Result populated**: each accepted header line adds one entry (possibly already present, in which case the add is a no-op) to the external-plans set.
- **Streaming open → Closed by end-of-file**: total-lines equals the file's line count.
- **Streaming open → Closed by upper-bound cap**: total-lines equals the first out-of-range line number; subsequent lines in the file are not read at all on this call.
- **Streaming open → Closed by stream error**: total-lines equals the number of lines counted at the point of the error; the result is resolved (never rejected).

The cursor that the polling tick persists between calls (so that the next call's lower-bound watermark is past everything already processed) is **not** updated by this scanner. The polling tick uses the line count returned by a sibling reference scan (capped at the same upper bound) as its persisted cursor and passes that line back in as both this scan's lower-bound watermark and upper-bound cap on subsequent calls.

## Notable Behavior

- **Single-source contract: every signal is an `apply_patch` request.** Codex has no slug signal, no canonical user-home plan directory, no plan-mode marker, and no `Write`/`Edit` tool. The only way a plan is announced in a Codex transcript is by editing a markdown file via a custom-tool patch application, which is why the slug set is always empty and the markdown filter is the only candidate gate. This was empirically verified against a 182-session, 1254-patch local corpus before fixing the envelope shape.
- **Cheap substring pre-filter.** Every transcript line is rejected up front unless it literally contains the substring `apply_patch`. This avoids JSON-parsing the overwhelming majority of transcript lines (assistant prose, tool results, etc.). The pre-filter has false positives (a prose line mentioning the words `apply_patch` will be JSON-parsed) but those collapse quickly at the envelope check.
- **Column-zero header match is load-bearing.** Hunk context lines (those starting with a single space) and added-or-removed body lines (those starting with `+` or `-`) in a markdown-document patch can contain text that reads exactly like a header. Matching only at column zero on the raw line — and never trimming the line first — is what prevents a context line `* Add File: docs/foo.md`-shaped string in an unrelated edit from being treated as a real Add. The path itself is trimmed; the line is not.
- **`Move to:` is a defensive add.** This token is the documented apply-patch syntax for the rename destination of an update block but was not observed in the local-corpus verification. It is implemented to spec so that a future or remote Codex session that does emit it is handled correctly; the on-disk existence gate downstream means that a stale source path emitted from the corresponding update header is harmless if the rename actually applied.
- **No tool-result inspection.** The scanner reads only the patch *request*. Whether the patch actually applied is unknown to it. The existence check in the downstream upsert is the deliberate stand-in for "the write landed", and admits a benign true-ish positive on a failed-update-to-a-pre-existing-file case (the file is registered as a plan even though the specific edit did not land). This deliberately matches the analogous Claude-side behavior so that both sources have one and the same success contract.
- **Total-lines is not the persisted cursor.** When the upper-bound cap fires, the total-lines value points at the first out-of-range line — one past the cap. The polling tick already holds a separate "reference-safe" line as its persisted cursor and passes that as the next call's both watermark and cap. The scanner's total-lines is informational; it is **not** a cursor target on the Codex path. (Conversely, Claude callers omit the upper bound and use the natural end-of-file total as their cursor, which is byte-equivalent to the pre-source-split behavior.)
- **Stream closed early on the first out-of-range line.** The scanner does not read the entire file just to count lines; once the upper bound is exceeded it tears down both the line reader and the underlying stream. This bounds I/O on long transcripts where only a small recent suffix is in scope.
- **Failure-resilient by construction.** Malformed JSON, wrong-shape envelopes, wrong types in `payload.*`, empty header bodies, and non-markdown extensions are all silently skipped; a stream-level read error resolves the promise with whatever was accumulated rather than rejecting. The driver above expects to be able to call this on a partially written transcript without special-casing.
- **Whitespace in paths is preserved.** A target like `docs/20260204 - Space plan.md` is a single path; the scanner does not split on whitespace. Only the outer leading/trailing whitespace on the post-colon segment is stripped.
- **Case-insensitive markdown filter.** A target ending in `.MD`, `.Md`, or `.mD` is accepted. Downstream basename-minus-extension slug derivation matches the same case-insensitive rule, so a mixed-case extension produces a clean slug.
- **`Delete File:` is intentionally ignored.** The corresponding file no longer exists on disk after a successful delete; the downstream existence gate would drop it regardless. Filtering it out at the scanner saves the path-resolution and set-insertion cost.
- **`apply_patch` and `function_call` are not the same envelope.** Some Codex documentation uses `function_call` terminology, but the verified shape on the local corpus is `custom_tool_call` with name `apply_patch`. A `function_call` entry whose name happens to be `apply_patch` is not recognized here. (Notable: a contract change at the agent layer would silently make this scanner stop producing candidates; this is the intended fail-closed behavior.)
- **Output set is unordered.** The external-plans set has no preserved insertion order; downstream consumers iterate it without ordering assumptions. The driver's per-slug upsert is commutative under the resolve-unique-slug rules, so order does not affect the eventual registry contents.
- **Always-empty slug set is part of the contract.** The shared driver branches on slug-set membership for the user-home canonical plan path; emitting an empty set is what causes the entire canonical-plan branch to be skipped for Codex transcripts.
- **Single-pass per line.** Each transcript line is parsed at most once and walked at most once; each patch-text line inside it is walked at most once. The scanner's time cost is linear in the windowed line count plus the windowed total patch-text bytes.

## Shared Behavior

- The source-agnostic upsert that consumes this scanner's output — including the external-plan exclusion policy (path segments and basenames), the on-disk existence gate, the note-source-path suppression, the base-slug-plus-eight-hex-suffix unique-slug rule, the archive-guard re-arm on content change, and the locked re-read / per-slug overlay that preserves concurrent writers — is defined by the shared transcript-plan-discovery spec (the Claude transcript plan-discovery spec, which now serves both sources).
- The Claude plan scanner is the sibling source-specific scanner for the same shared upsert; its envelope contract (a JSONL transcript with `slug` substrings and `Write`/`Edit` tool-use entries) differs from this one but it produces the same result shape (a slug set, an unfiltered external-plans set, and a total-lines count). The Claude scanner's slug set is non-empty (it carries plan-mode signals from the canonical user-home plans directory); this scanner's slug set is always empty.
- The Codex polling tick that schedules these scans — including how it picks transcripts, how it computes the reference-safe upper bound that caps this call, how it persists the cursor only when both the plan scan and the reference scan succeed, and how it backs off on errors — is defined by the Codex polling-tick spec.
- The Codex session discovery that identifies the transcripts the polling tick walks — including how it locates the Codex session-rollouts directory and translates them to in-product session records — is defined by the Codex session-discovery spec.
- The plans-registry on-disk envelope, its version field, and its sibling notes / references maps that this scan's upsert mutates around without disturbing are defined by the plans-registry spec.
