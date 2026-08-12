# 341. Kimi Skill Invocation Capture

## Topic Statement

Kimi Code CLI ships a first-class skill tool, so a skill use on this host is **observed** — a real tool call in the wire-event stream naming the skill it entered — and the records it produces carry no heuristic marker; the scan correlates each call with its result to learn whether the invocation succeeded, holds its own cursor before a call whose result has not landed yet, and groups the window's calls into one record per skill.

## Scope

**In scope**

- The two wire events the scan reads, the fields it takes from each, and the correlation between them.
- Recognition: the pre-filter, the envelope gate, the exact skill-tool-name gate, and the skill-id argument that must be present.
- The pending entry, the success flag and when it is upgraded, and the optimistic value a window-closing entry carries.
- The trailing-suffix cursor rewind and the two ways an entry can be exempt from holding the cursor.
- Assembly: grouping by skill id, invocation ordering, and every field the produced record deliberately omits.
- The subagent walk this host inherits, and why it is structurally empty here.
- Token attribution: why neither of the shared attribution paths can fire on this host's events, and the session key that is therefore computed but never attached.
- The session key's derivation from the session **directory** rather than the transcript file name, and its dormancy.
- Where this host sits in the line-oriented skill dispatch, and the contrast with the two other members.
- What drives the scan, and what does not.

**Out of scope**

- Session discovery, working-directory recovery, the transcript layout, and conversation normalization — spec 339.
- The discovery pass that calls this scan: its single-flight, its gates, its serial per-session loop, its two drivers and their shared commit-time deadline, and the *separate* shared cursor the reference scan rides — spec 340. This spec covers only the skill scan and its own high-water mark.
- Reference extraction from the same transcripts — specs 340, 153, 154.
- The skills extractor's cursor storage and the never-advance-on-a-throw protocol, the registry rows, the timestamp-keyed invocation fold, and the per-skill markdown ledger — spec 319.
- What the confidence and detection axes mean downstream, per-session splits, and detach correction — specs 321, 306.
- Archival onto a commit (spec 322) and every rendering surface (specs 323, 324).
- Driving this same CLI as a summary-generation backend. That is an unrelated role for the same binary.

## Data Contracts

### The two events

Both halves of a skill interaction arrive as a loop-event envelope wrapping an inner event, correlated by a call id:

| Half | Fields read |
| --- | --- |
| call | inner event type marker, correlation id, tool `name`, `args.skill` |
| result | inner event type marker, correlation id, `result.isError` |

The millisecond-epoch `time` sits on the **outer** envelope, not on the inner event. A result's payload text is never read — only its error flag.

### Pending entry

Held per correlation id: the skill id, the call's ISO timestamp, the **1-based** line number of the call line, a "result seen" flag, and a success flag.

### Produced record

One record per distinct skill id in the window:

- the source tag for this host,
- the skill id,
- an entry-path list holding the single value that means "entered through a tool",
- its invocations, each `{ timestamp, ok }`, ordered newest first.

Four things are deliberately absent:

- **No heuristic marker.** The invocation is observed, not inferred. This is the whole contrast with the sibling host that has no skill tool and can only recognise a shell command reading a skill document.
- **No plugin.** The skill id is flat; nothing in the call names a namespace.
- **No body size.** The result payload does carry the loaded skill text, but nothing reads it beyond the error flag.
- **No per-invocation cap.** Every matched call in the window becomes an invocation, unlike the inference-based sibling, which can only claim "this session used this skill" once per scan.

### Scan result

The records plus a single number: the **1-based** highest line consumed, floored at the window's start line so it can never move backwards.

## Behavior

### Scanning one window

Walking from the resume line to the end of the supplied lines:

1. Record the line as consumed **before** any filtering, so the cursor reflects how far the scan looked rather than how far it matched.
2. Skip a zero-length line.
3. **Cheap pre-filter:** the raw line must contain the loop-event envelope marker. Only that envelope carries tool activity.
4. Parse as JSON. A failure is skipped silently — a truncated last line is normal while a session is live. (Notable: the reference parser over the *same* stream logs a warning with a line preview here; this scan does not.)
5. Require an object whose top-level type is the envelope marker and whose inner event is an object.
6. **On a call event:**
   - The tool name must equal the host's dedicated skill-tool name **exactly**. Built-in tools and MCP tools are dropped here.
   - The arguments must be an object carrying a non-empty string skill id; without one the call is dropped.
   - Build the entry with the timestamp derived from the **outer** envelope and the call's own line number, mark it not-yet-answered and optimistically successful, and append it to the window's ordered entry list.
   - Register it under its correlation id **only if the call carried one**. A call with no correlation id is still reported — there is no way to ever learn its outcome — but it can never be paired and therefore can never hold the cursor.
7. **On a result event:**
   - Require a correlation id and a registered entry under it. A result for anything this scan is not tracking is dropped and does **not** move the tail boundary.
   - Set the success flag to "not an error": the flag is false only when the result object carries the error marker set to exactly true. A result with **no** result object at all therefore reads as a success.
   - Mark the entry answered and record this line as the **last paired-result line**.

### Timestamp conversion

The outer envelope's `time` is a millisecond epoch converted to an ISO 8601 instant. A non-numeric value, or a finite-but-absurd instant outside the representable range, yields the **empty string** rather than dropping the invocation — the record is still produced, carrying an empty timestamp.

### Cursor: trailing-suffix rewind

The returned line target is the count of lines consumed **unless** a matched call is still unanswered at the tail of the window:

- Consider only registered entries that are unanswered **and** whose line sits strictly after the last paired-result line. That boundary starts at the window's own start line, so in a window where nothing paired at all every unanswered entry qualifies.
- If any qualify, the target becomes the earliest such line **minus one**, so the next pass re-reads that call line and can correlate it once its result arrives.
- The result is floored at the window's start line, and the caller persists a mark only when it moved strictly forward — so a rewind landing at or below the start simply holds the cursor.

Scoping to the trailing suffix rather than to the globally-earliest unanswered call is load-bearing: a call that never receives a result at all — a cancelled tool, a killed session — sits *before* some later paired result, and letting it set the target would pin the mark at its line forever and re-scan the whole tail on every pass.

**A window-closing entry is reported anyway, with an optimistic success.** Failure is only knowable from the result, so the fragment claims success; the held cursor is what guarantees the next pass re-reads the pair, and the store's fold then corrects the invocation in place. An invocation can therefore be visible as successful before its failure is known. (Notable.)

### Assembly

Entries are grouped by skill id in first-seen order; each group's invocations are sorted **newest first**; one record per group is returned. Two calls of the same skill in one window produce one record with two invocations — not two records.

### Persistence, and the mark that gates it

Each produced record is upserted into the project's skill registry (spec 319). The scan runs against the skills extractor's **own** high-water mark, which advances only when the returned target moved strictly forward and never on a throw — so a failed pass leaves the mark where it was and the next pass retries the same window. Re-scanning is idempotent: the store identifies invocations by timestamp and folds duplicates away.

That mark is **independent of the shared cursor the reference scan rides** (spec 340): neither constrains how far the other advances in the same pass, which is why the skill scan runs even when the reference scan for the same session threw.

### The subagent walk is structurally empty here

The shared scan-and-persist step also scans a session's subagent transcripts, deriving their directory from the transcript file's own name. On this host the transcript file name is a constant, so the derived directory can never exist and the listing always comes back empty. This host **does** have sibling agent conversations on disk, one directory per agent, but they live under a different layout and nothing here reaches them: only the main agent's transcript is ever scanned. (Notable — the walk is inherited rather than skipped, so it costs one failed directory listing per session and finds nothing.)

### Token attribution: dormant, and the session key with it

The shared scan-and-persist step runs the same attribution pass every line-oriented source runs, from line 0 regardless of the scan cursor, and attaches a usage figure plus a session key to a record **only when a figure exists for that skill**. Neither of that pass's two paths can fire on this host:

- The **attributed** path groups spend by a per-record attribution field that this host's events do not carry.
- The **estimated** fallback opens an interval at a skill entry recognised as the *other* host's message-content tool-call block. This host's skill call is a correlated wire event, not that block, so no interval ever opens and nothing is summed.

So no usage is ever attached, and because the session key is attached only alongside a usage figure, it is never written either.

**The key is nonetheless computed correctly for this host, and that is a deliberate pre-emption.** Every other source names its transcript file after the session; this host's file name is a constant, and identity lives in the session directory three levels above it. Deriving the key from the file name — which is what every other source does — would collapse **every** session of this host onto one key. The derivation therefore takes the session directory's name instead. Dormant today because the host reports no usage; correct the moment it does. (Contrast the inference-based sibling host, whose key derivation is known-wrong and left that way for the same reason: it is never attached.)

### Dispatch and drivers

This host is a member of the line-oriented per-source skill dispatch, alongside the block-pairing host (observed, via its own skill tool) and the shell-inference host (heuristic). A source absent from that table has no skill extraction at all, and the reasons differ per source — that table's membership and its absences belong to spec 326.

The scan is driven from exactly one place: the hookless artifact-discovery pass for this host (spec 340), which calls it once per in-scope session, unconditionally, after that session's reference scan. That pass in turn has two drivers — the editor sidebar's refresh tick, and the commit-time queue drain — and the second is the only one a terminal-only user has.

**What is not a driver.** The re-enable catch-up sweep iterates the persisted session registry, and no path ever writes a session of this host into it (spec 339), so it can never reach these transcripts. There is no separate skill-only trigger anywhere.

## State Transitions

| From | Event | To | Notes |
| --- | --- | --- | --- |
| Skills mark at line N | scan returns a target greater than N | mark advances to that target | Persisted by the shared cursor step, outside this scan. |
| Skills mark at line N | scan throws | mark held at N | The same window is retried next pass. |
| Skills mark at line N | scan returns a target at or below N | mark held at N | Only a strictly-forward move is persisted. |
| Call seen, no result yet | window closes on it, in the trailing suffix | reported optimistically successful; mark held just before its line | Re-read next pass; the store's fold corrects the flag. |
| Call seen, no result yet | window closes on it, **before** the last paired result | reported optimistically successful; mark **not** held | An abandoned call cannot pin the mark. |
| Call with no correlation id | any | reported optimistically successful; never pairs, never holds the mark | Its outcome is unknowable. |
| Call seen | its result lands | success flag set from the result's error marker | An absent result object reads as success. |

## Notable Behavior

- **Observed, not inferred — and the record says so by omission.** There is no detection marker on any record this scan produces, because the host emits a real skill tool call. The sibling host with no skill tool infers a use from a shell command reading a skill document and marks every record heuristic; the two sit on opposite ends of that axis while producing the same record shape.
- **An invocation can be published as successful and later corrected.** A call whose result has not landed is reported with an optimistic success flag; the held cursor is the only thing that guarantees the correction ever happens. If the cursor were advanced past it, the failure would be lost permanently — the mark only moves forward.
- **A result carrying no result object reads as a success.** The flag is false only for an explicit error marker set to exactly true, so a malformed or empty result is recorded as a successful invocation. (Surprising.)
- **A call with no correlation id is still recorded.** It can never be paired, so it keeps the optimistic success forever — but for the same reason it can never hold the cursor either, so it costs nothing beyond the one uncorrectable flag.
- **The line target mixes a count with an index.** The ordinary branch returns a 1-based count of lines consumed; the rewind branch returns a 1-based call line minus one. Both are correct because the caller feeds the value back as a 0-based resume index — so the rewind lands the next pass exactly **on** the unanswered call.
- **The tail-boundary scoping is the fix for a pinned cursor, and the same fix exists twice.** The reference parser over this identical stream carries it too (spec 340), for the identical reason and against the identical failure: a cancelled tool's call would otherwise hold the mark forever and re-scan the tail on every pass.
- **A timestampless call is recorded with an empty timestamp rather than dropped.** The inference-based sibling host drops such a record outright, on the grounds that it cannot be ordered or deduped. This host keeps it.
- **The subagent walk can never find anything here**, because the directory it derives comes from the transcript file's name and that name is a constant on this host. The host's real sibling-agent conversations are laid out differently and are never read.
- **The session key is right for a feature that does not exist yet.** No usage figure is ever produced for this host, so the key is never attached — but it is derived from the session directory rather than the transcript file name, because that name is a constant and the ordinary derivation would collapse every session of this host onto one key.
- **A malformed line is skipped silently here and warned about by the reference parser.** Two scans read the same stream in the same pass with different noise policies; a transcript that is being appended to while it is read produces exactly one warning per truncated line, not two.
- **The scan runs even when the reference scan for the same session threw.** The two ride separate marks, so there is nothing to keep aligned; skipping it would strand skill lines behind a reference-side failure.

## Shared Behavior

- **Session discovery, working-directory recovery, the transcript layout, the wire-event families, and the millisecond-epoch timestamp rule** are owned by spec 339. That spec also owns the separate tool-call tally over the same stream, which re-attributes a skill-tool call to its skill id for counting purposes and is unrelated to the records here.
- **The discovery pass that calls this scan** — its single-flight with dirty rerun, its three gates, its serial per-session loop, its two drivers, the commit-time deadline it shares with the other hookless source, and the *shared* cursor the reference scan advances — is owned by spec 340.
- **The skills extractor's cursor protocol** (per-extractor high-water marks, advance only on a strictly-forward move, never on a throw), the registry rows, the timestamp-keyed invocation fold, and the per-skill markdown ledger are owned by spec 319.
- **The line-oriented skill dispatch table**, its other members, and the recorded reasons each absent source is absent are owned by spec 326.
- **The block-pairing host's extraction**, including the attribution pass this host inherits and the subagent walk it also inherits, is owned by spec 320. The two attribution paths' rules — dedupe by response identity, and never summing the cumulative cached-read counter — are owned by spec 321.
- **The manually-disabled zero-write contract** that gates the pass upstream is owned by spec 304.
- **Archival onto a commit** is owned by spec 322; rendering by spec 323; the editor's context row by spec 324.
