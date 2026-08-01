# Summary Attribution by Transcript Cutoff

## Topic Statement

Attribute each transcript entry to exactly one commit by treating the queue entry's creation timestamp as an upper-bound cutoff for transcript reads, so that conversation that happened after a commit was made is reserved for the next commit and never duplicated.

## Scope

**In scope:**
- The problem this mechanism solves and the conditions under which it is engaged.
- How the cutoff is propagated from the queue entry into transcript reading.
- How a transcript reader uses the cutoff to decide where to stop.
- How a per-transcript cursor is advanced after a partial (cutoff-bounded) read.
- The interaction between cursor advancement and processing failure.
- The behavior for transcripts whose underlying file no longer exists or has been truncated.
- Behavior when the cutoff is absent (manual or legacy paths).
- The one-time-discard exclusion pass that reads then drops conversations and references the user has unchecked, including the composite key shape used to address each excluded row.

**Out of scope:**
- Where the queue entry's creation timestamp is captured (covered by the queue-entry-format topic).
- The drain loop that calls into transcript reading (covered by the queue-worker topic).
- The on-disk shape of cursors or the registry that holds them (covered by the cursor-registry topic).
- The schema of individual transcript entries beyond the timestamp field (covered by transcript-source topics).
- The on-disk shape, write protocol, and sticky semantics of the exclusion set itself (covered by **Commit Exclusion Selection Store**); this spec only contributes how the exclusion set is observed when deciding what to read.

## Data Contracts

### Cutoff parameter

A single ISO 8601 timestamp string, threaded as an optional argument through the transcript-loading layer. When set, only transcript entries whose own timestamp is less than or equal to it are returned. When unset, the legacy "read to end of file" behavior is used.

### Source of the cutoff

The `created-at` field of the queue entry currently being processed by the worker. The same value is read into the transcript-reading layer for every transcript opened during the processing of one entry. The amend handler additionally accepts and forwards the same value.

### Per-transcript cursor

A small record per transcript file recording the last consumed line number, persisted to a registry inside the per-repository state directory. Two distinct fields drive cursor placement after a read:

- The number of new lines processed during the read.
- A "last consumed line index" that records the line position of the last line the reader actually advanced past, which differs from the file's end-of-file when the cutoff stops consumption mid-file.

### Update rule

After a transcript read:

- If a cutoff was supplied: cursor advances to the last consumed line, not to the file's end-of-file.
- If no cutoff was supplied: cursor advances to the file's end-of-file (legacy behavior, used by manual re-summarize and direct command-line paths).

### Save timing

The cursor is written to disk per transcript, immediately after that transcript's read returns, before the next transcript is opened.

### Exclusion-set inputs

Of the sets carried by the per-project commit-exclusion document, the conversation-exclusion and reference-exclusion sets affect this topic; the plan, note and skill sets do not:

- A set of conversation-exclusion keys. Each key is the composite string `<source>:<sessionId>`, where `<source>` is the producer tag of a recognised transcript source (Claude, Codex, Gemini, OpenCode, Cursor, Cursor CLI, Copilot CLI, Copilot Chat, Cline, Cline CLI, Devin, Antigravity) and `<sessionId>` is the producer-assigned session identifier. The colon is reserved across the product: no source tag contains one, so the key splits unambiguously.
- A set of reference-exclusion keys. Each key is the composite string `<source>:<nativeId>`, where `<source>` is the integration source and `<nativeId>` is the integration-native identifier of the row. Same shape as the reference map key carried elsewhere; no translation is performed.

Both sets are read once per queue-entry drain. They are never written by this topic — the exclusion document is invariant across a pipeline execution.

## Behavior

### Cutoff propagation through one drain

1. The worker pops a queue entry.
2. It calls the per-commit handler (full pipeline, amend pipeline, etc.) with the entry's `created-at` as a "before-timestamp" argument.
3. The handler calls into the shared "load all session transcripts" helper with that argument.
4. The helper computes the conversation-exclusion key set (see "Post-read exclusion discard") but does NOT drop any session before reading — every discovered session, checked or unchecked, flows into step 5.
5. The helper passes the argument unchanged into the per-source transcript reader for every discovered session (default Claude reader, Gemini reader, Codex reader, OpenCode reader, Cursor reader, Copilot CLI reader, Copilot Chat reader). Each reader honors the cutoff in the same way and advances that session's cursor. After all reads return, excluded conversations are discarded from the aggregated result at a single downstream point (see "Post-read exclusion discard").

### Post-read exclusion discard

The exclusion set does NOT gate transcript reading — every aggregated session is read so that every cursor advances. After the helper has aggregated the active-session list across all enabled sources:

1. Read the project's commit-exclusion document once and extract the conversation-exclusion set.
2. For each candidate session, compute its composite key as `<source>:<sessionId>` — where `<source>` is the session's source tag, defaulting to the historically-default tag (Claude) when the field is absent on legacy records. Collect the keys that are members of the conversation-exclusion set.
3. Run every session's transcript reader, **including the excluded ones**. An excluded session's transcript IS opened, its cursor IS loaded, and — critically — its cursor DOES advance to the cutoff / commit boundary and is saved during this drain, exactly like a checked session. Reading an excluded session is a one-time "read to advance the cursor, then discard".
4. After all readers return, drop the excluded conversations at a single downstream filter point: remove them from BOTH the aggregated entry stream (the per-session transcript list) and the per-session token map, so their entries never enter the summary and their token contribution never inflates the stored total.

Reference exclusion is consumed in parallel by the prompt-block assembly and the archive-side association path; it does not gate transcript reading. It is documented here only because its key shape (`<source>:<nativeId>`) is enumerated above as one of the two exclusion sets observed during a drain.

### Per-transcript read with cutoff

1. The reader loads the cursor for the transcript path; if absent, it starts at line zero.
2. It reads the file's content from disk.
3. It iterates lines beginning at the cursor's line number.
4. For each new line, it parses the line into a candidate entry. If the candidate has its own timestamp and that timestamp is strictly greater than the cutoff, the loop breaks immediately.
5. Lines that did not break are recorded as "consumed" by advancing the local "last consumed line index" past them, regardless of whether the candidate parsed to a real entry.
6. After the loop, the new cursor is constructed:
   - If the cutoff is set, the cursor's line number is the last consumed line index.
   - If the cutoff is not set, the cursor's line number is the total number of non-empty lines in the file.
7. The new cursor is returned alongside the produced entries.

### Handling of entries without timestamps

A transcript entry that lacks its own timestamp is included unconditionally and counts as consumed. The reasoning is positional: such an entry was written before the next time-stamped entry, and so it belongs to the same time window as that entry. The cursor advances past it.

### Cursor save after read

The shared transcript-reading helper, immediately after each per-transcript read returns, writes the new cursor to the per-repository cursor registry. The save happens regardless of whether any entries were returned.

### Cursor advancement on later commits

The next queue entry's processing opens the same transcripts, loads the now-advanced cursors, and reads from those positions onward up to its own (later) cutoff. Each transcript line is therefore exposed to exactly one queue entry's handler, and the boundary between commits is the cutoff timestamp.

### Manual / legacy paths

When the worker is invoked without a queue entry (for example, by the manual re-summarize command), no cutoff is provided. The reader then falls back to "read to end of file" semantics, advancing the cursor to end-of-file even if the file is later extended. This intentionally matches the pre-queue behavior of the command-line tool.

## State Transitions

### Per-transcript cursor across two consecutive commits in the same session

- **Cursor at line N, where the file has N+M lines, of which K have timestamps after the first cutoff** → after first commit's processing, cursor advances to N + M - K (not N + M).
- **After cursor at N + M - K, second cutoff later than first** → the second commit's read produces entries from N + M - K up to whichever line first exceeds the second cutoff (or end-of-file, if all remaining entries are within the second cutoff).

### Cursor advancement on processing failure

- The cursor save happens inside the transcript-reading helper, before the language-model call returns. If the language-model call throws, the queue entry is deleted by the worker (per the queue worker's no-retry policy) and the cursor remains advanced. The transcript window the failed entry was meant to summarize is therefore not re-readable from the cursor; a re-summarize for that commit, if invoked, would need to operate without the conversation it never persisted. (See Notable Behavior.)

### Sessions that ended before any commit

A session whose transcript was fully written and closed before the queue entry was created has every line's timestamp at or below the cutoff. The cutoff therefore never trips, the loop reads to end-of-file naturally, and the cursor advances to end-of-file. The cutoff path and the legacy path produce the same cursor in this case.

### Transcript files that were rotated, truncated, or deleted

If a transcript path no longer reads cleanly, the per-source reader rejects the read with an error. The shared transcript-reading helper catches per-source read errors for the database-backed sources (Codex's session store, OpenCode's database, Cursor's database, Copilot's database, Copilot Chat's per-workspace store) and continues to the next session, leaving that session's cursor untouched. For the line-oriented Claude/Gemini path, a hard read failure throws and is caught at a higher layer; a partial parse failure on a single line is logged and skipped without affecting other lines.

## Notable Behavior

- **The cutoff is the only mechanism that prevents one Claude Code session's continuing conversation from being attributed to the next commit.** Before the queue, a single-slot pending file was written when the language-model call started; if a second commit arrived while the call was running, the second commit's transcript window included everything the user typed during the first commit's language-model call. The cutoff replaces that window with the precise instant the queue entry was created. (Surprising; intentional, and the explicit motivation called out at the helper's documentation.)

- **The cutoff is enforced per-line, not per-batch.** The reader iterates lines and breaks the moment the first post-cutoff timestamp is observed. Subsequent lines, even if they would have parsed cleanly, are left for the next read. (Notable.)

- **The cursor advances exactly to the breaking line's position, not past it.** The breaking line is not consumed; the next read with a later cutoff will see it. (Notable.)

- **Untimed entries are conservatively retained in the current window.** Some transcript entries (system events, certain tool-use frames, streaming chunks) are emitted without their own timestamp. The reader treats the absence of a timestamp as "belongs to the current window," because the next time-stamped entry that follows them establishes their effective time. (Surprising; intentional.)

- **Save-immediately after each transcript.** The cursor is persisted before the next transcript is opened. A crash between two transcript reads does not roll back the first transcript's advancement. (Notable.)

- **Cursor advancement is not transactional with the language-model call.** The transcript bytes that drove the language-model call are persisted to the orphan ref alongside the resulting summary, so a successful pipeline records the conversation it used. A failed language-model call still advances the cursor (because the cursor save happens during the read, not after the model call) and the bytes persisted to the orphan ref are then nothing — the failed entry's conversation window is forfeit. The codebase explicitly notes this trade-off and references a future "persist transcripts before the language-model call" as the prerequisite for safe retry. (Surprising; intentional.)

- **Identical cutoff value applied to all sources in a single drain.** Codex's session store, OpenCode's database, Cursor's database, Copilot's database, Copilot Chat, Claude's JSONL, and Gemini's JSONL all receive the same cutoff string. Per-source clock skew or alternate timestamp formats are the readers' problem; the cutoff itself is a single ISO 8601 string. (Notable.)

- **Sessions discovered on demand also use the cutoff.** Codex/OpenCode/Cursor/Copilot/Copilot Chat are not pre-tracked by an agent hook; the worker scans for them at drain time. The cutoff is applied uniformly to those discovered sessions, and their per-transcript cursor state is registered the first time they're read. (Notable.)

- **Database-backed source failures are isolated.** A transient lock, schema drift, or deletion of an OpenCode/Cursor/Copilot database between scan and read is caught and logged, and the drain continues with the next session. The line-oriented sources (Claude, Gemini) handle per-line failures internally and rarely throw at the read API. (Notable.)

- **Legacy "no cutoff" semantics persist for manual paths.** The command-line manual re-summarize and certain test paths invoke the worker function without a queue entry; they receive no cutoff and the reader advances the cursor to end-of-file. This is intentional; the manual path's caller is presumed to know there is no later commit to compete for the tail of the transcript. (Notable.)

- **The amend handler threads the cutoff explicitly.** Every per-commit handler accepts the cutoff value via its own parameter list rather than reading it off a global; this is important because the worker may dispatch multiple kinds in one drain and each kind's handler is given its own entry's cutoff. (Notable.)

- **Excluded conversations are read and their cursor advances; only their entries are discarded.** The exclusion set does not gate reading. An excluded session's transcript is opened and its cursor advances to the commit boundary exactly like a checked session's; the excluded session's entries — and its per-session token contribution — are then dropped at a single downstream filter point so they never enter the summary and never inflate the stored token total. Selection semantics are "unchecked ⇒ discard": exclusion is a one-time read-and-discard that consumes the opted-out transcript window so the row leaves the working area, rather than holding the cursor so the row persists for re-checking. (This intentionally reverses an earlier behavior that kept excluded conversations unread so the user could re-check them; the motivation is called out at the read site.)

## Shared Behavior

- The creation of the queue entry's `created-at` timestamp is defined by the **Queue Entry Format** topic.
- The drain order in which cutoffs are applied (entry-by-entry, oldest first) is defined by the **Git Operation Queue Worker** topic.
- The on-disk format of the per-transcript cursor and its registry is defined by the cursor-registry topic.
- The per-source transcript readers (Claude JSONL, Gemini JSONL, Codex sessions, OpenCode database, Cursor database, Copilot CLI database, Copilot Chat workspace store) each implement the cutoff with the same per-line stop semantics.
- The persistence of consumed transcript bytes alongside the produced summary is defined by the transcript-persistence topic.
- The on-disk shape, sticky semantics, and write protocol of the exclusion document — including the `<source>:<sessionId>` conversation key shape and the `<source>:<nativeId>` reference key shape consumed by the pre-read exclusion pass — are defined by **Commit Exclusion Selection Store**.
