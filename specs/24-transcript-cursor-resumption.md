# 24. Transcript Cursor Resumption

## Topic Statement
Persist a small bookmark per (transcript, purpose) pair so that incremental scans of an append-only transcript artifact can resume from where the previous scan stopped, without re-reading already-processed lines.

## Scope

**In scope:**
- The on-disk shape of the cursor registry (a single versioned document mapping a key to a cursor record).
- The fields stored per cursor record.
- The composite-key convention that lets multiple, independent purposes track their own progress against the same transcript.
- The atomic file-replacement semantics of the registry.
- The "advance only on successful processing" rule and the two distinct advancement modes (advance-to-end and advance-to-last-consumed).
- Behavior when the underlying transcript file shrinks, is rotated, or disappears.
- Pruning of orphaned cursors when their backing session is dropped from the session registry.
- Behavior when the cursor registry document is absent, empty, or unparseable.

**Out of scope (boundaries):**
- The format of the transcript itself (per-source line schemas, message merging, content cleaning).
- The session registry that owns the staleness lifecycle for the underlying sessions, and that triggers orphan-cursor cleanup (covered by **Session Registry Pruning**).
- The semantics of any specific purpose key (what "summary" or "plan-scan" actually does with the cursor); this topic only specifies that purposes are namespaced and that the cursor mechanism is purpose-agnostic.
- The interaction between cursor reads and a wall-clock cutoff used to attribute lines to a specific commit (the cutoff is a parameter to the read; it does not change the cursor's storage shape).

## Data Contracts

### Cursor record
A record describing where a previous scan stopped. Its fields are:
- **transcript locator**: the absolute path to the underlying transcript file. Stored verbatim inside the record (in addition to being the registry key) so an isolated record carries enough information to re-attach to its file.
- **line offset**: a non-negative integer counting lines (1-indexed semantics: a value of N means "N lines have been consumed; resume at line N+1"). Empty lines and lines that fail to parse still count toward the offset, because the offset advances by raw input lines, not by produced entries.
- **recorded-at timestamp**: the ISO 8601 wall-clock time at which the cursor was last persisted.

The record does NOT track:
- A last-consumed message id, line hash, or content fingerprint. Resumption is line-count-based only.
- An end-of-file indicator. The cursor does not know whether the transcript has more lines after its offset.
- A purpose key inside the record itself. The purpose discriminator lives in the registry key (see "Composite key").

### Composite key (purpose × transcript)
The cursor registry's keys are strings constructed in one of two forms:
- **Bare locator** — the transcript's absolute path used directly as the key. This is the default purpose: incremental summarization scans of a session's transcript.
- **Prefixed locator** — the literal prefix `plan:` followed by the transcript's absolute path. This is the dedicated purpose for scanning a session's transcript for plan-file references.

The prefix is a fixed string. There is no general "register a new purpose" mechanism; purposes are added by introducing a new fixed prefix in the code that owns the scan. As of writing, two purposes exist: the unprefixed (summary scan) and `plan:` (plan-discovery scan).

### Cursor registry document
A single document persisted under the project-scoped state directory in a fixed sibling file to the session registry. Its fields are:
- **schema version**: integer, currently 1.
- **cursor map**: an object whose keys are composite keys as above and whose values are cursor records.

Encoded as JSON text with tab indentation.

### Read result (downstream contract — not stored)
The cursor reader's caller receives, alongside parsed entries, a freshly-built cursor record describing where to resume next time. This new cursor is not auto-persisted; the caller must explicitly save it.

## Behavior

### Save (the upsert path)
1. Ensure the project-scoped state directory exists.
2. Load the current cursor registry (see "Load").
3. Copy the cursor map and install the supplied cursor record at its key (the transcript locator on the supplied record, possibly prefixed by the caller before invocation).
4. Wrap the result in a fresh registry document with schema version 1 and write it atomically via the temp-file + rename primitive.

There is no validation that the supplied locator actually exists on disk; the registry stores whatever the caller provided.

### Load (single-key read)
1. Compute the absolute path to the registry document.
2. Attempt to read and parse it as JSON. On any error, return an empty registry document.
3. Look up the supplied key in the cursor map; return the matched cursor record or null if absent.

The lookup is verbatim by string equality on the composite key. The reader does NOT strip the `plan:` prefix; callers that want the plan-scan cursor must supply the prefixed key, and callers that want the summary-scan cursor must supply the bare locator.

### Read with resumption (the consumer path)
This is the pattern that makes the cursor useful, applied to every per-source transcript reader (Claude/Codex/Gemini/etc.):

1. Compute the composite key for the desired purpose and the target transcript.
2. Load the existing cursor record under that key, if any. The "start line" for this scan is the loaded record's line offset, or zero if no record exists.
3. Read the entire transcript file as UTF-8 text and split into raw lines, dropping blank lines.
4. Iterate from the start line onward, parsing each line and either producing a downstream entry or skipping it. Track a "last consumed line index" that increments with every line iterated, regardless of whether it produced an entry.
5. Optionally apply a per-line wall-clock cutoff (a parameter): when an entry's timestamp exceeds the cutoff, stop iterating immediately and do NOT advance past the previous line. This is the **advance-to-last-consumed** mode.
6. Without a cutoff, iterate to end-of-file and advance to the file's total raw-line count. This is the **advance-to-end** mode (legacy / non-cutoff path).
7. Build a fresh cursor record with the new line offset and the current ISO 8601 timestamp, and return it to the caller alongside the parsed entries. The caller is responsible for persisting it via "Save" only after downstream processing of the returned entries succeeds.

### Plan-scan resumption (purpose-specific call site)
The plan-discovery scan applies the same pattern with three differences:
1. It constructs the composite key by prepending the literal prefix `plan:` to the transcript locator.
2. Its "scan" does not return parsed entries; it walks the new lines looking for two specific patterns (a slug field and a write/edit-tool-call against a known plans directory). It updates a separate registry (the plans registry) on hit.
3. It always advances to the file's total raw-line count after the scan, even when zero matches are found, so that subsequent invocations do not re-walk the same lines.

### Orphaned-cursor pruning
Triggered as a side effect of pruning the session registry (see **Session Registry Pruning**). The flow is:
1. The session-registry pruning pass produces a list of stale transcript locators.
2. The cursor-cleanup routine loads the cursor registry, then for every key in the cursor map computes the "raw locator" by stripping a leading `plan:` prefix when present.
3. If the raw locator is in the stale-locators set, the entry is removed regardless of which purpose prefix was attached. A single stale session therefore prunes both its summary cursor and its plan-scan cursor in one pass.
4. If at least one entry was removed, the cursor registry is re-written atomically. If nothing matched, the cursor registry is left untouched (no spurious write).

There is no other pruning trigger: cursors are not aged out by their own recorded-at timestamp, and there is no maximum cursor-map size.

### Atomic write
Identical to the session registry's atomic-write primitive: write content to `<file>.tmp`, rename over the target, fall back to a direct overwrite + temp-file delete on platforms where the rename can fail with permission errors.

## State Transitions

The cursor registry document has two abstract states:
- **Absent / empty** — file does not exist, is unreadable, or is malformed. Reads return an empty document; lookups return null.
- **Populated** — file contains a valid registry document with zero or more cursor entries.

Allowed transitions:
- Absent → Populated: a successful save produces the file.
- Populated → Populated: every successful save replaces the document atomically with a new version. Pruning may shrink it; saving may grow or refresh it.
- There is no Populated → Absent transition.

Per-cursor lifecycle:
- **Created** by the first save under a new composite key.
- **Refreshed** by every subsequent save under the same key with a higher line offset and newer timestamp.
- **Removed** only by the orphan-pruning fanout when its session is pruned.

The line offset on a cursor is monotonically non-decreasing across normal use (each save reflects more processed lines than the previous), but the cursor mechanism does NOT enforce this — a buggy caller that produces a smaller new cursor and saves it will reduce the offset and cause subsequent reads to re-process lines.

## Notable Behavior

- **Multiple purposes per session are intentional.** The same transcript file is read by independent scans (incremental commit summarization vs plan-file discovery) at different cadences, with different "I successfully consumed this line" definitions. Storing one cursor per (purpose, transcript) lets each scan advance independently. The summary scan can be at line 12 000 while the plan scan is at line 4 000 against the same file. (Surprising-on-first-glance; load-bearing.)
- **The composite key is implemented as a string prefix, not a structured field.** The registry treats all keys as opaque strings. The convention that `plan:` means "plan-scan purpose" is enforced only by callers; pruning has the only piece of logic that strips the prefix, and it does so to compute the raw locator for matching against the stale-session set. (Surprising; deliberately minimal data model.)
- **The cursor counts lines, not entries.** A line that fails to parse, a blank line that was filtered out, and a comment line all advance the offset by one. The offset is therefore safe to compute against the raw split-by-newlines representation of the file but tells the caller nothing about how many useful entries lie below it.
- **Advance-only-on-successful-processing is a caller convention, not enforced by the registry.** The registry has no transactional API. The reader returns a candidate "next cursor" alongside the entries; the caller must do its downstream work first and only then call save. If the caller saves before processing and the process crashes, the next run will skip those lines. This is a known trade-off and is the reason the read API returns the new cursor as a value rather than auto-persisting it.
- **No detection of file shrink, rotation, or replacement.** The cursor stores only a line count and a recorded-at timestamp. If the underlying transcript file is truncated, replaced, or rotated such that line N is now different content, the next read using `slice(start)` will silently produce wrong results: it slices into the new content at the same line count. The reader does NOT compare file size, mtime, or inode against the cursor's recorded-at timestamp. There is also no error path for "transcript file is shorter than the cursor offset" — it returns an empty entries array and advances no further. (Surprising; the design accepts this because the supported transcript formats are all append-only in practice.)
- **Read errors are flattened to empty (consistent with the session registry).** A missing or corrupt registry document yields an empty cursor map, and individual lookups return null. Callers see "no prior cursor" and start from the beginning; there is no error surface for "registry exists but is corrupt."
- **The cutoff parameter changes the advancement mode.** When the caller passes a wall-clock cutoff (used by the queued-commit worker to attribute transcript lines to the correct commit), the reader advances only to the last line whose timestamp was at or below the cutoff. Without a cutoff, the reader advances to end-of-file. This means the same transcript file is read at two different cadences depending on whether the consumer is doing incremental scanning or commit-attributed scanning. The cursor's storage shape is identical in both cases.
- **Save signature is unchanged from a single-cursor-per-file ancestor design.** The save call accepts a cursor record whose `transcriptPath` field is the composite key the caller wants to persist under (possibly prefixed). A caller persisting a plan-scan cursor must therefore set the record's `transcriptPath` to `"plan:" + actualPath`, which is the same value used as the registry key. This mild violation of "the field should be the file path, not the key" is preserved for backward compatibility with the historical signature. (Surprising.)
- **Pruning is fan-in only — no scheduled cursor sweeps.** The cursor registry has no internal staleness threshold, no LRU cap, and no "prune cursors that point at non-existent files" job. The only way a cursor disappears is via the session-registry side effect described above. As a consequence, a cursor can persist indefinitely if a session is somehow refreshed every 48 hours; the only collateral damage is a slightly larger registry document.
- **There is one implementation of this registry.** The former JVM-based port is gone, and no code on the JVM-hosted surface reads or writes the cursor document — the filename survives there only inside a comment. That surface obtains an unread transcript slice by asking for it over a bridge action, so the cursor is consulted and advanced entirely by this implementation. One consequence is worth noting: when that surface cannot determine the project directory it sends the transcript file's own parent directory as the working directory, which resolves the cursor document under the wrong project root. (Notable.)

## Shared Behavior
- The session-registry pruning pass that triggers orphan-cursor cleanup is defined by **Session Registry Pruning**. That topic also defines the staleness threshold, the cleanup fan-out point, and the join-key invariant (transcript locator).
- The atomic-write primitive (temp-file + rename, with Windows fallback) is shared with the session registry, plans registry, configuration, and pending-state files; see **Session Registry Pruning** for the full description.
- The format and parsing of individual transcript lines (per-source) and the merging of consecutive same-role entries are owned by the per-source transcript-reader topics, not by this cursor mechanism.
