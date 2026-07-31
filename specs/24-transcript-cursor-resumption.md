# 24. Transcript Cursor Resumption

## Topic Statement
Persist a small bookmark per transcript, in one registry document per scanning purpose, so that incremental scans of an append-only transcript artifact can resume from where the previous scan stopped, without re-reading already-processed lines.

## Scope

**In scope:**
- The on-disk shape of a cursor registry (a versioned document mapping a transcript locator to a cursor record), and the fact that two such sibling documents exist — one per purpose.
- The fields stored per cursor record.
- The one-document-per-purpose convention that lets independent purposes track their own progress against the same transcript, and the one-shot fold that retired an earlier prefixed-key scheme.
- The atomic file-replacement semantics of a registry.
- The "advance only on successful processing" rule and the two distinct advancement modes (advance-to-end and advance-to-last-consumed).
- The optional resume anchor: which kind of producer needs one, that it is opaque to this mechanism, and the full-re-read fallback taken when it can no longer be located.
- The conjunctive advance rule the merged plan-plus-reference watermark is subject to, and the three surfaces that write it.
- Behavior when the underlying transcript file shrinks, is rotated, or disappears.
- Pruning of orphaned cursors when their backing session is dropped from the session registry.
- Behavior when a cursor registry document is absent, empty, or unparseable.

**Out of scope (boundaries):**
- The format of the transcript itself (per-source line schemas, message merging, content cleaning).
- The session registry that owns the staleness lifecycle for the underlying sessions, and that triggers orphan-cursor cleanup (covered by **Session Registry Pruning**).
- What any specific purpose actually does with the cursor; this topic only specifies that purposes are separated by document and that the cursor mechanism is purpose-agnostic. The two scans that share the merged discovery watermark are owned by spec 29 (plans) and spec 153 (references); the surfaces that drive them are specs 26, 180, and 305.
- The interaction between cursor reads and a wall-clock cutoff used to attribute lines to a specific commit (the cutoff is a parameter to the read; it does not change the cursor's storage shape).

## Data Contracts

### Cursor record
A record describing where a previous scan stopped. Its fields are:
- **transcript locator**: the absolute path to the underlying transcript file. Stored verbatim inside the record (in addition to being the registry key) so an isolated record carries enough information to re-attach to its file.
- **line offset**: a non-negative integer counting lines (1-indexed semantics: a value of N means "N lines have been consumed; resume at line N+1"). Empty lines and lines that fail to parse still count toward the offset, because the offset advances by raw input lines, not by produced entries.
- **recorded-at timestamp**: the ISO 8601 wall-clock time at which the cursor was last persisted.
- **resume anchor** (optional): an opaque, producer-defined token naming the last unit the previous scan consumed. It exists for producers whose transcript is *not* a stable append-only stream, and exactly one producer sets it today — the one whose conversation is stored as a forest of alternate regenerations, where accepting a regeneration re-points the canonical chain and invalidates a raw positional count. For that producer the anchor is literally the identifier of the last conversation node consumed. Producers whose transcripts really are append-only leave it unset.

The record does NOT track:
- A line hash or content fingerprint. Resumption is by line count for every producer that leaves the resume anchor unset, and by the anchor for the one producer that sets it; no producer resumes by comparing transcript content.
- The identity of the last **model response** consumed. The resume anchor is not that identity and is never used as one — it names a position in a conversation, not an API response, and the producer that sets it is not the producer whose transcripts carry token usage at all. So on the usage-bearing path the anchor is always absent, and the consequence below holds because *that producer does not use the anchor*, not because this record could not carry one. The consequence: the summarization consumer de-duplicates token usage by the identity of the model response a record belongs to (one response is written across several records, each repeating the whole usage object), and that already-counted set is built and discarded inside a single read because nothing here persists it. A response whose records straddle a read boundary is therefore counted by both reads. The over-count is bounded at one response per boundary and was accepted rather than adding a response-identity field to this record. See spec 16 and **Token Usage Extraction and Cost Estimation**.
- An end-of-file indicator. The cursor does not know whether the transcript has more lines after its offset.
- A purpose discriminator. The purpose is determined by *which document* the record is stored in (see "Two registry documents").

### Registry key
Every cursor is keyed by the transcript's absolute path, verbatim — no prefix and no other decoration. Lookups are exact string equality on that path.

An earlier scheme packed several purposes into one document by prepending a fixed purpose prefix to the locator. That scheme is retired: nothing writes a prefixed key any more, and the only code that still reads one is the one-shot fold described below.

### Two registry documents
Purposes are separated by **document**, not by key. Two sibling documents live in the project-scoped state directory, alongside the session registry:

- **Summarization document** — the watermark for the incremental transcript read the source-control commit pipeline performs. Written by that pipeline only.
- **Merged discovery document** — a single watermark shared by the plan scan and the reference scan of the same transcript. One line count serves the pair; there is no separate per-scan watermark.

There is no general "register a new purpose" mechanism; a purpose is added by introducing another document. As of writing, exactly these two exist.

### Cursor registry document (shape, identical for both)
Each document's fields are:
- **schema version**: integer, currently 1.
- **cursor map**: an object whose keys are transcript locators and whose values are cursor records.

Encoded as JSON text with tab indentation.

### Read result (downstream contract — not stored)
The cursor reader's caller receives, alongside parsed entries, a freshly-built cursor record describing where to resume next time. This new cursor is not auto-persisted; the caller must explicitly save it.

## Behavior

### Save (the upsert path)
1. Ensure the project-scoped state directory exists.
2. Load the current registry for the purpose's document (see "Load").
3. Copy the cursor map and install the supplied cursor record under the transcript locator carried on that record.
4. Wrap the result in a fresh registry document with schema version 1 and write it atomically via the temp-file + rename primitive.

There is no validation that the supplied locator actually exists on disk; the registry stores whatever the caller provided. The save entry points are per-purpose: a caller chooses the document by choosing which entry point it calls, not by decorating the key.

### Load (single-key read)
1. Compute the absolute path to the purpose's registry document.
2. Attempt to read and parse it as JSON. On any error, return an empty registry document.
3. Look up the supplied transcript locator in the cursor map; return the matched cursor record or null if absent.

The lookup is verbatim by string equality on the locator. A lookup in one document never sees the other document's cursor for the same transcript, which is what keeps the two purposes independent.

### Read with resumption (the consumer path)
This is the pattern that makes the cursor useful, applied to every per-source transcript reader (Claude/Codex/Gemini/etc.):

1. Select the document for the desired purpose; the key is the target transcript's locator.
2. Load the existing cursor record under that key, if any. The "start line" for this scan is the loaded record's line offset, or zero if no record exists — **unless** the record carries a resume anchor, in which case the anchor wins: the reader rebuilds the producer's canonical sequence, locates the anchor in it, and starts just past it. An anchor that can no longer be found (a regeneration dropped that node behind the cursor) is not an error and does not fall back to the line offset — the scan restarts from the beginning of the conversation, because resuming at a positional count into a re-pointed sequence would silently skip the regenerated turns. Re-reading is the cheaper mistake; the duplicate work is bounded by one conversation.
3. Read the entire transcript file as UTF-8 text and split into raw lines, dropping blank lines.
4. Iterate from the start line onward, parsing each line and either producing a downstream entry or skipping it. Track a "last consumed line index" that increments with every line iterated, regardless of whether it produced an entry.
5. Optionally apply a per-line wall-clock cutoff (a parameter): when an entry's timestamp exceeds the cutoff, stop iterating immediately and do NOT advance past the previous line. This is the **advance-to-last-consumed** mode.
6. Without a cutoff, iterate to end-of-file and advance to the file's total raw-line count. This is the **advance-to-end** mode (legacy / non-cutoff path).
7. Build a fresh cursor record with the new line offset and the current ISO 8601 timestamp, and return it to the caller alongside the parsed entries. An anchor-setting producer additionally stamps the new record with the identity of the last unit it actually consumed, and carries the incoming anchor forward unchanged when this pass consumed nothing new. The caller is responsible for persisting the record via "Save" only after downstream processing of the returned entries succeeds.

### Merged discovery resumption (the shared-watermark purpose)
The plan scan and the reference scan of one transcript share a single watermark in the merged discovery document. Both are handed the *same* start line. The reference scan's reported line is the authoritative advance target; the plan scan's own reported line is discarded and the two are never reconciled.

The watermark is persisted only when **both** of the following hold — a conjunctive rule:
1. the plan scan completed without throwing, **and**
2. the reference scan's reported line is strictly greater than the start line.

Otherwise nothing is written and the whole window is re-offered on the next pass. Advancing on the reference scan alone would strand a plan window permanently, which is exactly what the plan-scan condition prevents; re-offering is safe because both scans are idempotent.

Three surfaces write this one watermark, all under the same conjunctive rule and all against the same key:

1. **The per-turn pass**, driven by the first agent's turn-completion event, over one transcript. Both scans read to end-of-file, plan first (spec 26).
2. **The polling surface's recurring discovery tick**, over conversations it discovers on demand. It reverses the order — reference scan first, then a plan scan *capped* at the reference line — so that the lines it processes are exactly the lines the watermark will cover (spec 180).
3. **The re-enable drain**, over every non-stale session the project's session registry still holds, one gated write per transcript that actually had unscanned lines (spec 305). It mirrors the per-turn pass's uncapped, plan-first order rather than the polling surface's.

None of the three ever moves a watermark backwards, and none of them writes the summarization document.

### One-shot legacy fold
A one-shot migration folds the retired prefixed keys out of the summarization document into the merged discovery document. Each retired key contributes its line count to that locator's merged entry via the **minimum** against whatever the merged entry already holds (absent ⇒ the contributed count is taken as-is). Where a locator carried both retired purposes, the lower of the two therefore wins. Minimum, not maximum: the merged watermark must never sit past either retired scan's prior progress, and the small re-scan overlap it causes is harmless because both discovery scans are idempotent, whereas the maximum would skip unprocessed lines outright. Both documents are then rewritten — the merged document gains the folded entries, and the summarization document is rewritten without the folded keys, preserving every other entry in it.

The fold is idempotent and returns **without writing either document** once no prefixed key remains. It also ensures the project-scoped state directory exists. It is not a start-up migration: each of the three discovery writers performs it inline before reading its watermark — once per transcript on the per-turn pass, once per tick on the polling surface, once per run on the re-enable drain.

### Orphaned-cursor pruning
Triggered as a side effect of pruning the session registry (see **Session Registry Pruning**). The flow is:
1. The session-registry pruning pass produces a list of stale transcript locators.
2. The cursor-cleanup routine visits **both** documents in turn and, in each, removes every entry whose key is in the stale-locators set. Because both documents are keyed by the bare locator, this is a direct membership check with no key rewriting.
3. Per document, if at least one entry was removed, that document is re-written atomically. A document that matched nothing is left untouched (no spurious write) — so a stale session with a summarization cursor but no discovery cursor rewrites only the one document.

A single stale session therefore drops both its summarization watermark and its merged discovery watermark in one pass. There is no other pruning trigger: cursors are not aged out by their own recorded-at timestamp, and there is no maximum cursor-map size.

### Atomic write
Identical to the session registry's atomic-write primitive: write content to `<file>.tmp`, rename over the target, fall back to a direct overwrite + temp-file delete on platforms where the rename can fail with permission errors.

## State Transitions

Each cursor registry document, independently, has two abstract states:
- **Absent / empty** — file does not exist, is unreadable, or is malformed. Reads return an empty document; lookups return null.
- **Populated** — file contains a valid registry document with zero or more cursor entries.

Allowed transitions:
- Absent → Populated: a successful save produces the file.
- Populated → Populated: every successful save replaces the document atomically with a new version. Pruning may shrink it; saving may grow or refresh it.
- There is no Populated → Absent transition.

Per-cursor lifecycle (within one document):
- **Created** by the first save under a new transcript locator, or — for the merged discovery document only — by the one-shot fold materializing an entry from retired prefixed keys.
- **Refreshed** by every subsequent save under the same locator with a higher line offset and newer timestamp.
- **Removed** only by the orphan-pruning fanout when its session is pruned, or — for a retired prefixed key in the summarization document only — by the one-shot fold.

The line offset on a cursor is monotonically non-decreasing across normal use (each save reflects more processed lines than the previous), but the cursor mechanism does NOT enforce this — a buggy caller that produces a smaller new cursor and saves it will reduce the offset and cause subsequent reads to re-process lines.

## Notable Behavior

- **Multiple purposes per session are intentional.** The same transcript file is read by independent scans (incremental commit summarization vs plan-and-reference discovery) at different cadences, with different "I successfully consumed this line" definitions. One document per purpose lets each advance independently: the summarization watermark can be at line 12 000 while the discovery watermark is at line 4 000 against the same file. (Surprising-on-first-glance; load-bearing.)
- **Purposes are separated by document, not by key — and that is a change of scheme, not just of naming.** The earlier design kept one document holding the summarization watermark under the bare locator plus a separately-prefixed key per discovery scan. The current design moves discovery into its own document, collapses its two prefixed keys into one shared watermark, and drops prefixes entirely — which is why pruning is now a plain membership check and why neither reader has to know about the other's keys. The prefixed form survives only as fold input. (Surprising if you have read the older shape; the fold is the only bridge.)
- **Plan discovery and reference discovery collapsed into ONE watermark, not two.** They are separate scans with separate side effects but a single shared line count, advanced only when both are satisfied. So the two can never drift apart, and neither can be resumed independently of the other. (Surprising; load-bearing — it is what makes the conjunctive advance rule necessary in the first place.)
- **Three independent surfaces write the merged discovery watermark against the same key.** A per-turn hook pass, a recurring polling tick, and a re-enable drain all advance the same per-transcript value. They agree on the advance rule and on the key, but not on scan order: the polling surface scans references first and caps its plan scan at the reference line, while the other two scan plans first and uncapped. The uncapped form can therefore process lines beyond the line the watermark is set to and re-read them next pass — work, not incorrectness, because both scans are idempotent. (Surprising; see specs 26, 180, 305.)
- **Storing no response identity costs the summarization consumer one duplicated response per boundary.** The record can carry a producer-defined resume anchor, but the producer whose transcripts carry token usage does not set one, and an anchor would not serve as a response identity even if it did. So the reader's per-read de-duplication of repeated usage records cannot span a resumption: a model response whose records fall on both sides of a cutoff has its tokens counted twice. Known, bounded, and deliberately not fixed by adding a response-identity field. (Surprising; intentional — see spec 16.)
- **Resumption is line-count-based for most producers but not for all, and the exception changes the failure mode rather than refining it.** A producer whose stored conversation can be *re-pointed* by a regeneration resumes by an opaque anchor instead, and when that anchor is gone it re-reads the whole conversation rather than resuming positionally. So a non-append-only producer trades duplicate work for correctness, while every append-only producer keeps the silent-wrong-slice risk described below. (Surprising; the anchor is the only field here whose meaning this mechanism does not define.)
- **The cursor counts lines, not entries.** A line that fails to parse, a blank line that was filtered out, and a comment line all advance the offset by one. The offset is therefore safe to compute against the raw split-by-newlines representation of the file but tells the caller nothing about how many useful entries lie below it.
- **Advance-only-on-successful-processing is a caller convention, not enforced by the registry.** The registry has no transactional API. The reader returns a candidate "next cursor" alongside the entries; the caller must do its downstream work first and only then call save. If the caller saves before processing and the process crashes, the next run will skip those lines. This is a known trade-off and is the reason the read API returns the new cursor as a value rather than auto-persisting it.
- **No detection of file shrink, rotation, or replacement — except by the one producer that sets a resume anchor.** For every other producer the record carries only a line count and a recorded-at timestamp, so if the underlying transcript is truncated, replaced, or rotated such that line N is now different content, the next read resumes at the same line count into the new content and silently produces wrong results. No reader compares file size, modification time, or inode against the cursor's recorded-at timestamp. There is also no error path for "transcript is shorter than the cursor offset" — the read yields no entries and advances no further. The anchor-setting producer is the exception, and detecting exactly this class of change is why its anchor exists: it validates the anchor against the freshly-rebuilt sequence and re-reads from the start when it is gone. (Surprising; the design accepts the general case because the other supported transcript formats are all append-only in practice.)
- **Read errors are flattened to empty (consistent with the session registry).** A missing or corrupt registry document yields an empty cursor map, and individual lookups return null. Callers see "no prior cursor" and start from the beginning; there is no error surface for "registry exists but is corrupt."
- **The cutoff parameter changes the advancement mode.** When the caller passes a wall-clock cutoff (used by the queued-commit worker to attribute transcript lines to the correct commit), the reader advances only to the last line whose timestamp was at or below the cutoff. Without a cutoff, the reader advances to end-of-file. This means the same transcript file is read at two different cadences depending on whether the consumer is doing incremental scanning or commit-attributed scanning. The cursor's storage shape is identical in both cases.
- **The save call carries the key inside the record.** A save takes a cursor record and derives the registry key from the locator field on that record, rather than taking a key and a value separately. With the prefix scheme retired the two are now always the same value, so the arrangement is no longer surprising — but it does mean a caller cannot save a record under a key other than the locator it names. (Notable; a signature inherited from a single-cursor-per-file ancestor design.)
- **The fold is the only step that writes when there is nothing to advance.** Every other path here writes only after a scan made progress, so a pass over a fully-scanned transcript performs no cursor write at all. A project that still carries retired prefixed keys is the one exception: its first discovery pass rewrites both documents (and creates the project-scoped state directory) before scanning anything. Once folded, that never happens again. (Notable; it is why spec 305 qualifies its "a no-backlog run performs no writes" claim.)
- **Pruning is fan-in only — no scheduled cursor sweeps.** The cursor registry has no internal staleness threshold, no LRU cap, and no "prune cursors that point at non-existent files" job. The only way a cursor disappears is via the session-registry side effect described above. As a consequence, a cursor can persist indefinitely if a session is somehow refreshed every 48 hours; the only collateral damage is a slightly larger registry document.
- **There is one implementation of this registry.** The former JVM-based port is gone, and no code on the JVM-hosted surface reads or writes the cursor document — the filename survives there only inside a comment. That surface obtains an unread transcript slice by asking for it over a bridge action, so the cursor is consulted and advanced entirely by this implementation. One consequence is worth noting: when that surface cannot determine the project directory it sends the transcript file's own parent directory as the working directory, which resolves the cursor document under the wrong project root. (Notable.)

## Shared Behavior
- The session-registry pruning pass that triggers orphan-cursor cleanup is defined by **Session Registry Pruning**. That topic also defines the staleness threshold, the cleanup fan-out point, and the join-key invariant (transcript locator).
- The atomic-write primitive (temp-file + rename, with Windows fallback) is shared with the session registry, plans registry, configuration, and pending-state files; see **Session Registry Pruning** for the full description.
- The format and parsing of individual transcript lines (per-source) and the merging of consecutive same-role entries are owned by the per-source transcript-reader topics, not by this cursor mechanism.
- The three surfaces that read and advance the merged discovery watermark are owned by spec 26 (the per-turn pass driven by the agent's turn-completion event), spec 180 (the recurring polling tick, whose reversed and capped scan order is its own), and spec 305 (the re-enable drain, including its per-session skips, its failure isolation, and its hoisting of the one-shot fold out of the per-session loop). Each of them states the same conjunctive advance rule from its own side; the storage of the watermark, its key form, its document, and the fold are owned here.
- The two scans that share that watermark are owned by spec 29 (plan discovery) and spec 153 (reference extraction). Neither owns the watermark; both are handed a start line and one of them reports the advance target.
