# 184. Transcript Message Counter With Overlay

## Topic Statement

For a given AI coding session, produce the count of visible conversation messages exactly as the conversation detail panel would render them, by parsing the producer's transcript with the producer-specific parser, applying the user's persisted overlay (edits, deletions), and returning the number of surviving entries.

## Scope

**In scope:**

- The two-stage pipeline that turns a session locator into a count: per-producer parse, then identity-based overlay application, then a length read of the resulting array.
- The two cursor modes the counter exposes:
  - **Full-transcript mode** — every parsed entry, overlay applied, length returned. This is the canonical "panel-equivalent" count.
  - **Unread-slice mode** — only the slice of entries past the cursor recorded by the commit pipeline for this transcript handle, overlay applied. Used by the active-conversations row builder to drop rows whose entire history has already been summarized.
- The "merged transcript" loader the counter is built on: a single helper that performs (per-source parse) + (overlay apply) and returns the merged array. Both the count call and any caller that wants both the count and a derived view (title, badge) share this one disk pass.
- The "raw unread transcript" loader that returns the cursor-trimmed parsed entries **without** overlay application. Used by the detail panel to compose its own overlay view on top of an identity-aligned raw array.
- The per-producer dispatch table for the unread-slice mode, which differs from the full-mode dispatch because some sources stream JSONL line-by-line and others read whole files or sqlite databases.
- The source-missing fallback rule: a session whose producer field is absent is treated as the Claude Code producer in both modes.
- The project-root-missing fallback rules: with no project root, no overlay is applied (full mode reverts to raw parse) and no cursor is consulted (unread mode reverts to full mode).
- The error-tolerance contract: every per-source reader failure, every overlay-load failure, and every cursor-lookup failure degrades to an empty result rather than throwing.
- The per-call I/O cost (no cache between calls) and the memory profile (linear scan, full materialization).

**Out of scope (boundaries):**

- The per-source parsers themselves — how each producer's JSONL / JSON-document / sqlite format is decoded into a parsed-entry array, including the producer-specific rules for which raw rows count as "visible" (tool-use-only Claude lines drop, Codex non-`event_msg` events drop, Gemini `info` rows drop, etc.). Each producer has its own discovery / reader spec; this counter only consumes their parsed output. (See per-producer discovery specs.)
- The conversation overlay store's persistence format, atomic save semantics, dedupe rules, identity-collision handling, and prune-on-consume sweep. The counter consumes only the "load overlay" and "apply overlay" operations as black boxes. (See overlay store spec, cross-ref 183.)
- The cursor file's persistence format, write semantics, lock contract, and how the post-commit pipeline advances it. The counter consumes only the "load cursor for this transcript handle" lookup.
- The downstream consumer's use of the count — how the active-conversations aggregator drops empty rows, sorts the survivors, attaches selection / hidden / edited flags, or ships the result to a sidebar. (See active-session aggregator spec, cross-ref 155.)
- The detail panel's full rendering path — the panel itself uses the raw-unread loader to build a separate identity-aligned view for overlay-identity resolution; the rest of its surface (rendering, edit gestures, persistence) is its own spec.

## Data Contracts

### Inputs

The counter accepts three logically-distinct input shapes, each used by a different entry point.

**1. Session locator (for the full-transcript and unread-merged operations).** A record carrying:

| Field           | Type    | Meaning                                                                                                          |
| --------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| session id      | string  | The opaque, producer-supplied identifier for the session. Used to address the overlay file.                     |
| transcript handle | string | The producer-supplied locator for the underlying transcript. For sqlite-backed sources this is a synthetic `<dbPath>#<sessionId>` string; for file-backed sources this is the absolute file path. Forwarded verbatim to the per-source reader. |
| last activity   | string  | The session's last-update timestamp in ISO-8601. Not consumed by the counter itself; carried because the locator is shared with other call sites. |
| producer        | producer enum (optional) | Which agent produced the session. **When absent**, treated as the Claude Code producer throughout the pipeline.            |
| native title    | string (optional) | Not consumed by the counter; carried by the shared locator.                                                       |

**2. Raw-unread locator (for the raw-unread operation only).** A flat triple: `(producer, transcript handle, project root?)`. The producer is required here (no defaulting at this entry point).

**3. Project root (optional, on every entry point).** Absolute path of the project the caller is asking about. Drives the overlay-file lookup and the cursor lookup. Omitting it disables both, with the per-mode fallbacks defined below.

### Outputs

Three output shapes, one per entry point pair:

- **Count operation** — a non-negative integer: the length of the overlay-applied entry array.
- **Merged-entries operations** — a read-only array of parsed entries, each carrying `(role, content, timestamp?)` where role is `"human"` or `"assistant"`. Both the full-transcript merged operation and the unread merged operation return this shape; they differ only in which entries are included.
- **Raw-unread operation** — the same parsed-entry array, but with no overlay applied. Used by surfaces that need positional alignment between an edited view and a raw view.

### Producer enum

The same closed enumeration used throughout the product: `claude`, `codex`, `gemini`, `opencode`, `cursor`, `cursor-cli`, `copilot`, `copilot-chat`, `cline`, `cline-cli`, `devin`, `antigravity`, `kimi`. The counter dispatches on this enum and falls back to Claude Code when the field is absent on a locator.

### Per-source dispatch contracts

The counter's per-source dispatch differs between **full-transcript mode** and **unread-slice mode**, because the two upstream readers expose different surfaces.

**Full-transcript mode** (used by the count operation and the full-merged operation): the per-source dispatch hands the locator's transcript handle to a per-source loader, which returns the full parsed-entry array. These producers own dedicated single-artifact readers, dispatched before the line-streamed table is consulted: Gemini (JSON document); OpenCode, Cursor, Copilot CLI and Devin (SQLite databases); Cline (VS Code) and Cline CLI (plain-JSON files); Cursor CLI (plaintext JSONL); Antigravity (whole-file transcript). The remaining producers — Claude Code, Codex, Copilot Chat and Kimi Code CLI — share a line-streamed JSONL loader that selects the per-producer parser by enum value.

**Unread-slice mode** (used by the unread-merged operation and the raw-unread operation): the per-source dispatch is a per-source switch that calls each producer's dedicated reader with the saved cursor. Specifically:

| Producer       | Reader semantics                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------------------- |
| Gemini         | Single-document reader called with the cursor.                                                                   |
| OpenCode       | SQLite reader called with the cursor.                                                                            |
| Cursor         | SQLite reader called with the cursor.                                                                            |
| Copilot CLI    | SQLite reader called with the cursor.                                                                            |
| Copilot Chat   | JSONL reader called with **`cursor ?? undefined`**, normalizing a missing cursor to the undefined sentinel.      |
| Codex          | Generic JSONL reader called with the Codex line-parser strategy.                                                 |
| Kimi Code CLI  | Generic JSONL reader called with the Kimi line-parser strategy — an explicit arm, unlike Claude Code, which is served by the default arm below. |
| Devin          | SQLite reader called with the cursor.                                                                            |
| Cursor CLI     | Plaintext-JSONL reader called with the cursor.                                                                   |
| Cline (VS Code) | Plain-JSON reader called with the cursor.                                                                       |
| Cline CLI      | Plain-JSON reader called with the cursor.                                                                        |
| Antigravity    | Whole-file reader called with **`cursor ?? undefined`**, normalizing a missing cursor to the undefined sentinel — same as Copilot Chat. |
| **Default** (Claude Code; also any unknown producer that arrives through the missing-source default) | Generic JSONL reader called with the Claude Code line-parser strategy. |

The unknown-producer fall-through is deliberate: the locator's producer field defaults to Claude Code one level upstream, so an unrecognized value would already have been replaced by `"claude"` before reaching the switch. The default branch nonetheless catches the residual case where a future producer enum value reaches the switch without being added explicitly — that session decodes as Claude Code (a graceful degradation) instead of throwing.

### Overlay application contract (consumed)

The counter consumes the overlay store as two operations:

- **Load overlay for `(project root, producer, session id)`** — returns either a parsed overlay record or null. Null means: no overlay file, or the file was missing / unreadable / malformed / belonged to a different `(producer, session id)`. Failures inside the overlay store never throw out to the counter; the counter sees `null` for every degraded case.
- **Apply overlay to entry array** — receives an array of parsed entries and the overlay record (or null) and returns a new array with deletes dropped and edits' `newContent` substituted by identity match on `(role, content, timestamp?)`. Order is preserved. A null overlay is a no-op (returns the input).

The applied semantics for "visible" are therefore: an entry is visible iff (a) it was not filtered out by the per-producer parser, and (b) no delete rule's identity tuple matches it. An edited entry is still visible — only its content is replaced.

### Cursor lookup contract (consumed)

The counter consumes the cursor store as one operation: **load cursor for `(transcript handle, project root)`** — returns either a cursor record (carrying a starting line number / position) or `null`. The lookup is local to the project root's per-project state directory; a project root that lacks a cursor file, or whose cursor file is missing this transcript handle, yields `null`. A `null` cursor is treated by each unread-mode reader as "start from the beginning of the transcript", except as noted in the Copilot Chat row above.

## Behavior

### Entry point A: count visible messages for a session

Inputs: a session locator and an optional project root.

1. **Resolve the producer.** If the locator's producer field is present, use it; otherwise default to Claude Code.
2. **Load the full parsed transcript** by dispatching to the per-source full-mode loader with `(producer, transcript handle)`. Any failure inside the loader degrades to an empty array (the loader itself catches and returns `[]`).
3. **Resolve the overlay.** If a project root was provided, load the overlay for `(project root, producer, session id)`. Otherwise the overlay is `null`.
4. **Apply the overlay** to the parsed entry array. With a `null` overlay this is a no-op.
5. **Return the array length.** This is the count.

The count is therefore the number of entries that survived (a) the per-producer parser's "is this row visible?" rules and (b) the overlay's delete rules. Edited rows count as 1; their replaced content does not affect the count.

### Entry point B: full merged transcript (no count)

Same flow as Entry point A but returns the merged array directly instead of its length. Exists so a caller that needs both the count and a derived view (e.g. a title fallback) pays for one parse + one overlay-apply, not two.

### Entry point C: unread merged transcript

Inputs: a session locator and an optional project root.

1. **Project-root-missing fallback.** If the project root is absent, delegate to Entry point B (the full merged transcript). The cursor cannot be located without a project root, so the unread semantics collapse to "everything is unread".
2. **Resolve the producer** from the locator with the Claude Code default.
3. **Load the cursor for the transcript handle** from the project root's cursor store. May be `null`.
4. **Dispatch to the per-source unread-mode reader** using the switch above. The reader receives the cursor (or, for Copilot Chat, `cursor ?? undefined`). The reader returns a result envelope; the counter extracts its entries array.
5. **Load the overlay** for `(project root, producer, session id)`. Project root is guaranteed present at this point.
6. **Apply the overlay** to the entries.
7. **Return the merged entries** (the consumer reads `.length` if it wants the unread-slice count).

### Entry point D: raw unread transcript

Inputs: a producer, a transcript handle, an optional project root.

1. **Project-root-missing fallback.** If the project root is absent, return the full parsed transcript (Entry point B's first stage, no overlay — there's no project to look one up in anyway). This keeps the detail panel functional in read-only mode (e.g. when the workspace is closed but the panel was opened from a saved deeplink).
2. **Wrapped in a single catch:**
   - Load the cursor for the transcript handle. May be `null`.
   - Dispatch to the per-source unread-mode reader (same switch as Entry point C).
   - Return the reader's entries (no overlay applied).
3. **On any throw** within the wrapped block: warn-log and return an empty array.

The raw-unread operation deliberately swallows reader errors. This is the only entry point that returns `[]` on a thrown error from a non-ENOENT reader failure; the merged operations rely on each full-mode loader to swallow its own errors internally.

### Per-source full-mode loader behavior (consumed contract)

Each full-mode loader takes `(transcript handle)` and returns a parsed-entry array. Per-source behavior the counter relies on:

- **Gemini / OpenCode / Cursor / Copilot CLI** — wrapped in a try/catch inside the loader; ENOENT is silent, every other error warn-logs and returns `[]`. The loader **never throws**.
- **Claude Code / Codex / Copilot Chat / Kimi Code CLI** — line-streamed JSONL; per-line parse failures are silently skipped (with a single end-of-stream debug log carrying the skipped count); stream-level failures are caught with ENOENT silent and others warn-logged, then `[]` is returned. Again, the loader **never throws**.

The counter never wraps the full-mode loader in its own try/catch because the loader's own failure-isolation contract makes it impossible for the loader to throw. (See Notable Behavior for the consequence if that contract is ever violated.)

### Per-source unread-mode reader behavior (consumed contract)

Each unread-mode reader returns a result envelope with at least an entries array and a new cursor; the counter consumes only the entries. Per-source behavior:

- The readers **do** throw on hard failures (locked SQLite, schema drift, malformed synthetic-path, dynamic-import failure). Only the raw-unread entry point catches these; Entry point C (unread merged) does not catch the reader's throw and would propagate it.

This asymmetry is real: the unread-merged path is used inside the active-session aggregator, which has its own per-row try/catch that catches the throw, so wrapping it here would double-up the error handling. The raw-unread path is called from surfaces that don't have an outer catch, so it owns the catch itself.

### Error tolerance: summary table

| Failure mode                                                   | Count entry point (A)         | Full merged (B)            | Unread merged (C)              | Raw unread (D)                  |
| -------------------------------------------------------------- | ----------------------------- | -------------------------- | ------------------------------ | ------------------------------- |
| Transcript file missing (ENOENT)                               | 0                             | `[]`                       | Reader throws → propagates     | `[]` (caught silently)          |
| Transcript file locked / malformed / sqlite schema drift       | 0                             | `[]`                       | Reader throws → propagates     | `[]` (caught with warn-log)     |
| JSONL line mid-write (transient)                               | Line skipped silently         | Line skipped silently      | Line skipped silently          | Line skipped silently           |
| Overlay file missing                                           | No overlay, raw count         | Raw entries                | Raw entries (cursor-trimmed)   | (overlay not consulted)         |
| Overlay file malformed / corrupt                               | No overlay, raw count         | Raw entries                | Raw entries (cursor-trimmed)   | (overlay not consulted)         |
| Cursor file missing / cursor entry missing                     | (cursor not consulted)        | (cursor not consulted)     | Read from line 0               | Read from line 0                |
| Project root absent (count / merged)                           | No overlay; raw count         | Raw entries                | Falls back to full merged      | Falls back to full parse        |

Every cell that says "raw count / raw entries" means: the parser's filtering still applies; the overlay's filtering does not.

### Memory and I/O cost

- **No cache between calls.** Every call re-parses the transcript and re-loads the overlay. A consumer that calls this on a refresh tick re-pays the cost every tick.
- **Linear scan, full materialization.** The counter buffers the full parsed array (or full unread slice) in memory before counting. Memory scales with transcript size, not constant. The active-conversations refresh path is gated by `count > 0` rules at a layer above so the cost is bounded by sessions whose unread slice is non-empty within the recency window.
- **One disk read per concurrent leg.** Within a single Entry point A call: one full-mode loader call (one disk pass, including any sqlite open), plus one overlay-file read. The two reads can run in any order; in practice, the loader runs first and the overlay read is awaited after it.
- **Concurrent overlay loads are isolated.** When a caller (e.g. the active-conversations aggregator) fans the counter out across many sessions in parallel, each call is independent: the overlay reads do not contend for any in-process lock, and the per-source loaders open their own per-call streams or sqlite connections.

## State Transitions

The counter is **stateless across calls**. There is no in-process cache of parsed transcripts, no cache of loaded overlays, no cache of cursor lookups, and no shared mutable state between the entry points. The only state changes that occur during a single call are:

- Each per-source loader / reader opens, reads from, and closes its own input (stream, sqlite connection, single-shot file read). These resources are released before the loader returns.
- The overlay store's "load" operation opens and closes the overlay file as a one-shot read; no handle is retained.
- The cursor store's "load" operation reads the cursor registry file once per call; no handle is retained.

No call to the counter ever writes to disk, ever invokes an LLM, or ever takes a lock that outlives the call.

## Notable Behavior

- **The count is "panel-equivalent", not "raw-transcript-equivalent".** A session whose raw JSONL has 100 lines but whose user has deleted 50 of them via the overlay returns 50, not 100. This is the entire reason the counter applies the overlay — the sidebar's count badge would otherwise mismatch the user's curated view of the same session.
- **An edit does not change the count.** A delete drops the entry from the count; an edit replaces its content but keeps the row. This matches what the panel renders.
- **Delete wins on a row that has both a delete and an edit rule with the same identity.** The overlay-apply step skips the delete-matched entry before consulting the edits, so the deleted-then-edited row is gone, not resurrected. (See overlay spec for the rationale.)
- **A session with no producer field is treated as Claude Code throughout.** This default is applied independently at every entry point — the count, full-merged, unread-merged, and raw-unread paths each re-apply it — because the locator's producer field is genuinely optional and legacy data still arrives without it.
- **Project root absent has different consequences on different entry points.** On the count and full-merged paths, "absent project root" means "no overlay" (raw count survives). On the unread-merged path, it means "fall back to the full merged transcript" (the cursor cannot be located, so the unread slice would be meaningless). On the raw-unread path, it means "fall back to the full parsed transcript". These three fallbacks are not symmetric; the differences are deliberate.
- **`countTranscriptMessages` is not the only count call site.** The active-conversations aggregator does not use the count entry point; it uses the merged-transcript entry point directly and reads `.length` itself, so it can share the merged array with downstream title resolution. The count entry point exists as a convenience wrapper.
- **The Copilot Chat AND Antigravity unread readers receive `cursor ?? undefined`, not `cursor` directly.** Every other per-source reader accepts `cursor | null`; those two readers accept `cursor | undefined`. The coalescing normalizes a missing cursor to the form the reader expects. Those two are the only producers in the switch that take this normalization step. Every other producer passes cursor (possibly null) straight through. (Notable; reader-signature quirk preserved as contract.)
- **The unknown-producer default arm of the unread switch falls through to the Claude Code parser, not to a throw.** Combined with the upstream missing-producer-defaults-to-Claude rule, this means a forward-compatible new producer that gets through the type-guard at a trust boundary still decodes its transcript as Claude Code rather than crashing the counter. The misdecode will produce nonsense, but the call returns instead of throwing.
- **The full-mode loader's no-throw contract is load-bearing.** The count entry point does not wrap the loader in its own try/catch — it relies on the loader's internal failure isolation. If the loader is ever changed to throw on a non-ENOENT error, the count operation will start throwing too, with no inner safety net. The unread-merged path has the same property.
- **The raw-unread path is the only entry point that re-throws into an internal catch.** It owns the catch because its callers (notably the detail panel) cannot assume an outer catch will be in place. The other three paths rely on the loader's no-throw contract or on the caller's own catch.
- **`loadUnreadTranscript` (raw-unread) does NOT apply the overlay.** It exists specifically so the detail panel can derive a positionally-aligned raw view it can match overlay rules against by index. Applying the overlay here would invert the panel's design. The merged-unread path is the right call when the consumer wants the visible view. (Surprising; intentional.)
- **The merged-unread path applies the overlay loaded by `(project root, producer, session id)`, not the overlay anchored to the cursor's slice.** This means a delete rule whose identity tuple matches an entry that the cursor already advanced past has no effect on this call (because the matched entry isn't in the slice at all). Such "stale" overlay rules are pruned at commit time by the overlay store's prune sweep, so they don't accumulate forever.
- **The merged-unread path does not pass the cursor's saved line number through to the overlay match.** Identity matching is purely on `(role, content, timestamp?)`; the cursor only constrains which entries are in the input array.
- **The counter does not deduplicate identical entries.** A session that contains two `(role, content, timestamp)`-identical lines (rare, but possible with sources that don't emit timestamps) counts both. The overlay identity match against such a pair will hit the first match; the second remains. This is consistent with the detail panel's behavior.
- **The memory profile is linear in transcript size, not constant.** An earlier docstring claimed constant; the implementation materializes the full array before counting. The 48-hour activity window and the empty-row drop at the aggregator level bound the cost in practice. A future profile that pins this as a bottleneck would need the upstream loader to expose a streaming callback so the counter could `++count` without buffering.
- **There is no cache between calls.** Every refresh of a sidebar that calls this counter re-parses every active session's transcript and re-reads every overlay. The aggregator's own design choice (no cache) is what drives this; the counter has no opinion on the matter.
- **The four entry points share the (load → overlay) helper.** The count operation is implemented as `(load-and-overlay).length`. The full-merged operation returns `(load-and-overlay)` directly. The unread-merged operation is structurally similar but composes a different load step. The raw-unread operation skips the overlay step. The shared helper is the only place the "two-step parse + overlay" rule is written, so the two surfaces (panel and sidebar) never drift on the rule. (Load-bearing.)
- **Source-app appends during a read are handled at the loader layer, not here.** JSONL loaders silently skip mid-write lines; sqlite readers see a snapshot at sqlite's transaction boundary. The counter sees a consistent (if potentially slightly-stale) array.

## Shared Behavior

- The per-producer parser rules — including Claude Code's compaction-summary skip, tool-use-block discard, IDE-tag stripping, and skill-injection prefix filter, plus Codex's `event_msg` filtering, plus Kimi Code CLI's wire-event decoding (prompt-turn events become human entries, text content parts become assistant entries, reasoning parts and every other event family produce nothing), plus the Gemini / OpenCode / Cursor / Copilot CLI / Copilot Chat producer-specific decoding — are owned by the per-producer discovery / reader specs and the canonical parser strategy. This counter consumes the resulting "visible entries" array as a black box.
- The conversation overlay store, including the identity-matching rules `(role, content, timestamp?)`, the delete-wins-over-edit precedence, the dedupe-on-save rules, the prune-on-consume sweep, and the on-disk format, is defined by the conversation overlay spec (cross-ref 183). This counter consumes the load and apply operations only.
- The cursor file / cursor registry is owned by the cursor / summary pipeline specs; the counter consumes only the "load cursor for this transcript handle" lookup.
- The active-session aggregator (cross-ref 155) consumes both the merged-unread and merged-full operations to populate row fields (message-count, title-cascade fallback). The aggregator's empty-row drop, its overlay-edited flag, and its sort are all owned by that spec; this spec covers only what the aggregator receives.
- The detail panel that uses the raw-unread loader to compose its identity-aligned view is its own surface; this spec covers only the raw-unread operation it consumes.
