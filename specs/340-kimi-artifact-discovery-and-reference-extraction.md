# 340. Kimi Artifact Discovery and Reference Extraction

## Topic Statement

Because Kimi Code CLI exposes no lifecycle hook, a hook-free discovery pass scans its recent sessions and extracts external references — and skill usage — from their wire-event transcripts, driven from two independent trigger points and guarded by a per-workspace single-flight with a dirty-rerun.

## Scope

**In scope**

- The per-workspace single-flight registry, the dirty-rerun protocol, and the never-rejects contract.
- The three gates the pass checks in order, and the fact that each returns silently.
- The per-session loop: cursor load, reference scan, skill scan, conditional cursor advance, and the two nested failure boundaries.
- The deliberate absence of a plan scan for this source.
- The two drivers, and how each differs (fire-and-forget on a refresh tick; awaited and deadline-bounded at commit time, racing concurrently with the other hookless source against one shared deadline).
- The wire-event envelope parser: the pre-filter, call/result correlation by id, the MCP-prefix gate that drops built-in tool calls, cutoff handling on both halves of a pair, result-payload decoding, the arguments-derived escape hatch, and the empty permalink map.
- The cursor contract: what advances the shared cursor, and the trailing-suffix rewind rule that holds it before an unanswered call.
- Which source definitions are reachable through this parser and which are not, and the mechanism that decides it.
- What is *not* a driver for this source.

**Out of scope**

- Session discovery, working-directory recovery, transcript layout, and conversation normalization — owned by spec 339.
- Skill invocation capture itself (recognition, folding, cursor) — owned by spec 341; this spec covers only its position in the pass.
- The shared context-normalizer registry invoked once a payload is decoded — owned by spec 342.
- The shared extraction pipeline around the parser (payload-tree walk, dedupe, per-reference persistence) — owned by spec 153.
- Which definition owns which tool, and each definition's field extraction — owned by specs 153 and 154.
- The refresh tick itself and the panel it feeds.
- The commit pipeline's queue drain, its progress stream, and its watch ceilings.

## Data Contracts

### In-flight registry

Keyed by workspace directory. Each value holds the in-flight promise plus a mutable **dirty** flag.

### Envelope shapes

Both halves of a tool interaction arrive as a loop-event envelope with an inner event correlated by a call id:

| Half | Inner event fields read |
| --- | --- |
| call | event type marker, correlation id, tool `name`, `args` (the tool input) |
| result | event type marker, correlation id, `result.output` (a **string**), `result.isError` (read only by the skill scanner) |

The **outer** envelope carries the millisecond-epoch `time`; the inner event does not. Timestamps are converted to ISO 8601, or to the empty string when `time` is absent, non-numeric, or an out-of-range instant.

### Pending call entry

Held per correlation id until its result lands: the resolved source definition, the tool name, the call's `args` object, the call's ISO timestamp, and the **0-based line index** of the call line.

### Normalized tool result (handed to the shared pipeline)

The resolved definition, the tool name, the normalized payload, the **1-based** line number of the *result* line, and the result's timestamp.

### Returned cursor

A single number: either the count of lines traversed, or — when the trailing-suffix rewind fires — the 0-based line index of the earliest unanswered call. The caller consumes the value as the next window's start line and the scan treats its start line as 0-based, so the two conventions are consistent.

## Behavior

### Single-flight with dirty rerun

1. A call for a workspace with a pass already in flight sets that pass's **dirty** flag and returns the same promise. There is no queue.
2. Otherwise a new entry is registered and the pass begins; the entry is removed when the pass settles, success or failure.
3. The pass runs its body in a loop: clear the dirty flag, run one pass, and repeat while the flag is set again. A caller arriving mid-pass therefore causes exactly one more pass afterwards, rather than waiting a full tick for rows written after the in-flight pass had already enumerated sessions.

The public call **never rejects** — every error is caught and logged — so callers may fire it and discard the promise without risking an unhandled rejection.

### Gates, in order

Each returns silently, doing nothing:

1. **Manually disabled.** A pass writes cursors, references and skills into the project's state directory, all of which a manually-disabled project must not receive — and the refresh tick keeps firing while the disabled panel is shown.
2. **Per-source discovery toggle set to `false`.** Absent or `true` both mean enabled.
3. **Host not installed** (its data root is absent or not a directory).

### One pass

1. Fold any legacy cursor rows into the current cursor layout (idempotent).
2. Discover this source's recent sessions for the workspace (spec 339).
3. Walk the sessions **serially**, so per-session cursor writes never race inside one batch. For each session, inside a per-session try/catch:
   1. Load the shared discovery cursor for the transcript; absent means line 0.
   2. **Reference scan.** Run the shared extraction pipeline over the transcript from that line with this source's tag, and keep both its returned safe cursor and a "completed" flag. A throw logs a warning and leaves the safe cursor equal to the starting line with the flag clear.
   3. **Skill scan.** Run the skill scan against its **own** independent high-water mark. It neither constrains nor is constrained by how far the shared cursor moves this pass, and it is run unconditionally — a failed reference scan does not skip it.
   4. **Advance.** Save the shared cursor only when the reference scan completed **and** its safe cursor moved strictly forward. Any other outcome holds the window so the next pass re-scans it; re-scanning is idempotent because the pipeline dedupes by registry key and persistence upserts by the same key.
4. Log a one-line summary (sessions scanned, cursors advanced) **only when at least one session was found**, so an idle tick stays silent.

A top-level try/catch wraps the whole body, because configuration loading, cursor migration and session discovery can each throw; swallowing there is what makes the never-rejects contract hold.

### No plan scan

Unlike the sibling hookless source, this pass runs **no** plan scan. This host writes no plan markdown — its transcript carries tool calls and their results, not authored plan documents — so there is nothing for a plan scan to find. As a direct consequence the reference scan's safe cursor is not used to cap a second scan's window; it only decides whether and how far the shared cursor advances.

### Drivers

Two, and neither alone covers every user:

- **The editor sidebar's active-conversations refresh tick.** Resolves the workspace directory and fires the pass without awaiting it. This is what gives the panel sub-minute freshness.
- **The commit-time queue drain.** This is the **only** driver for a user who runs this host from a terminal with no editor window open; without it their references and skills would stay empty. It differs from the tick in three ways:
  - It is **awaited**, because the association step that follows reads the registry this pass writes.
  - It is **deadline-bounded**, because a person is waiting: the post-commit hook tails the worker and blocks until a terminal event or its watch ceiling. Steady state is cheap (the cursor means only the transcript tail is read) but a first pass over a large session history is unbounded. On timeout the pass is **abandoned, not cancelled** — its writes still land, and its own cursor makes the next commit resume where this one stopped.
  - It runs **concurrently with the other hookless source's pass, against one shared deadline.** Both are launched together and the pair is raced as a unit, so the total time charged to the user-waited path stays bounded no matter how many hookless sources exist. Each source's promise carries its **own** rejection handler, so one source's failure cannot void the other's result; the outer try/catch additionally survives a synchronous throw, which no rejection handler could see.

**What is not a driver.** The re-enable catch-up sweep iterates the *persisted* session registry, and no path ever writes a session of this host into it (spec 339), so that sweep can never reach this source's transcripts. It is not skipped by name — it simply has nothing of this source to iterate. (Notable; the sibling hookless source *is* excluded from that sweep by an explicit name check, which reads as though every hookless source were handled there.)

### Envelope parsing

Walking lines from the start line to the end of the window:

1. Record the line as traversed **before** any filtering, so the cursor reflects how far the scan looked, not how far it matched.
2. Skip a zero-length line.
3. **Cheap pre-filter:** the raw line must contain the loop-event envelope marker. Only that envelope carries tool activity.
4. Parse as JSON. A failure logs a warning with a truncated preview of the line and continues.
5. Require an object whose top-level type is the envelope marker and whose inner event is an object. Compute the timestamp from the **outer** envelope.
6. **On a call event:**
   - Require a string tool name and a string correlation id.
   - Require the tool name to start with the **MCP server prefix**. Built-in tools (file reads, shell, glob) carry bare names and are dropped here — see the reachability rule below for what that costs.
   - Apply the optional cutoff to the **call**: a call past the cutoff is not stashed at all, so its later result finds no pending entry and is dropped in turn.
   - Resolve the definition by matching the tool name against the **block-pairing agent's** match table, verbatim. There is no source-specific match rule and no new agent identity for this host. No match drops the call.
   - Stash the pending entry under the correlation id.
7. **On a result event:**
   - Require a string correlation id and a pending entry under it; a result for an untracked call is dropped and does **not** move the tail boundary.
   - Record this line as the **last paired-result line** — the tail boundary the rewind below is scoped against.
   - Apply the cutoff: past it, the pending entry is deleted **first** (so it can never pin the cursor as an in-flight call) and the result is dropped.
   - Require the result object to carry a **string** `output`; otherwise delete the pending entry and drop.
   - Decode `output` as JSON. On failure:
     - if the resolved definition declares itself **arguments-derived**, hand the normalizer an **empty object** and continue — such a definition builds its reference entirely from the call's arguments, so an unparseable (often prose) result is expected and dropping it would silently lose every one of that source's references from this host;
     - otherwise delete the pending entry and drop. Every non-declaring definition genuinely needs its payload.

     Either way the call has been answered, so the pending entry is removed and the cursor is free to advance past it.
   - Run the shared context-normalizer (spec 342) with the definition, the tool name, the call's `args`, the decoded payload, and an environment carrying an **always-empty permalink map** plus the caller's extraction options. The environment's other two members — the harvested design-file link map and the unparsed result text — are **omitted entirely**; both are optional and display-only by that contract, so the omission degrades two sources' labels rather than dropping any reference (see the reachability section). A `null` return voids the reference and it is dropped.
   - Emit a normalized tool result at the **result** line.
8. Sort the emitted results by line number so the shared dedupe's later-seen-wins tie-break is stable.

### Cursor: trailing-suffix rewind

The returned cursor is the count of lines traversed **unless** a matched call is still unanswered at the tail of the window:

- Consider only pending calls whose line index is **strictly greater than** the last paired-result line. The tail boundary starts one below the window's start line, so in a window where nothing paired at all, every pending call qualifies.
- If any qualify, the returned cursor becomes the **earliest** such line index, so the next pass re-reads that call and can correlate it once its result arrives. Re-scanning is idempotent via the shared dedupe and upsert-by-key.

Scoping to the trailing suffix rather than to the global-minimum unpaired call is load-bearing: a call that never receives a result at all — a cancelled tool, a killed session — sits *before* some later paired result, and letting it set the target would pin the cursor at its line forever and re-scan the whole tail on every tick.

A call carrying no correlation id was never stashed, so it can never hold the cursor.

## Reachability of source definitions through this parser

Identity resolution reuses the block-pairing agent's match table **verbatim**. A definition is therefore reachable from this host only when its entry in that table declares a **generic, server-prefixed** tool-name shape — the shape a user's own MCP registration in this host's configuration produces. A definition whose only declared shape is the **hosted first-party-connector namespace** cannot be matched here, because a session of this host does not produce tool names in that namespace.

That is the rule; the following is the enumeration it currently yields, and it must be re-derived from the definitions rather than trusted as a count:

- **Reachable** — the issue-tracker source (declares a generic server prefix alongside its connector alias), the code-forge source, the documentation-lookup source, the self-referential memory source (its generic prefix narrowed by an exact tool allow-list), the deployment source (again a generic prefix alongside its connector alias), and the design-file and error-tracking sources (each declaring two generic spellings and no connector alias at all — the spellings differ only in the case of the server segment, which is the user's own registration name, and matching is case-sensitive, so one spelling alone would capture nothing on half the installs). For the design-file source the missing connector alias is grounded: its vendor has no entry in the hosted connector directory, so that spelling would be a fabricated name, which silently never matches. Nothing establishes the same about the error-tracking source's vendor, so the absence there is not the same statement and must not be read as one.
- **Unreachable from this host** — the task-tracker source, the wiki-page source, the second issue-tracker source, the notes-and-pages source, the team-chat source, the board-item source, the meeting-assets source, and the hosted-document source. Each of these declares only the hosted connector namespace. Their normalizers and extraction pipes exist and are exercised from the block-pairing agent's transcripts; from this host they are simply never reached.

Covering one of the unreachable definitions means adding a generic prefix to that definition, pinned to a real capture of that server's tool naming under this host — not adding anything to this parser.

Two further consequences of the same rule:

- **The shell-command binding is unreachable from this host.** A reference source that both other producers can reach by recognising a command-line invocation in a shell tool call is invisible here, because this parser drops every tool call whose name lacks the MCP server prefix before any command string is examined. That source remains reachable from this host through its MCP server only.
- **The arguments-derived escape hatch is reachable for every definition that declares the flag**, since all of them — the documentation-lookup, self-referential memory, design-file and error-tracking sources — are in the reachable set above. That is not a coincidence to lean on: each of the four builds its reference from the call's arguments, and each declares generic server prefixes, so nothing about this host prevents any of them from being matched.

- **Two display-only inputs the block-pairing parser supplies are NOT supplied here, and every reference from the two affected sources degrades accordingly.** This parser hands the shared normalizer no harvested design-file link map and no unparsed result text, both of which that contract declares optional. The consequences are total rather than occasional, because nothing on this host can ever provide either:
  - Every **design-file** row takes its key-derived placeholder title (a fixed prefix plus a truncated file key) instead of the file's human name, and its link is the legacy universal file form built from the key alone rather than the canonical typed link a pasted link would have supplied. That universal form is unverified for a branch key and for the vendor's generated-app file kind.
  - Every **error-tracking** row takes its bare-id title instead of the issue's error description, carries **no display fields at all** (both of them are harvested from the prose result), and its body carries no culprit line.

  Neither degradation loses a row: identity, dedupe and the link are built from the arguments alone, so both sources still produce complete, correctly-keyed references on this host. What is lost is entirely label and detail. (Notable — the arguments-derived flag is often read as "the payload does not matter", and for these two sources the payload is precisely what the *display* comes from on the other parser.)

## State Transitions

| From | Event | To | Notes |
| --- | --- | --- | --- |
| Idle | pass requested | in-flight entry registered | Removed when the pass settles. |
| In-flight | pass requested again | dirty flag set; caller joins the same promise | No queue; exactly one extra pass follows. |
| In-flight | any gate trips, or any throw | resolves with nothing done | Debug/warning log only. |
| Shared cursor at line N | reference scan completes and moves forward | advances to the returned safe cursor | Saved per session, inside the loop. |
| Shared cursor at line N | reference scan throws | held at N | The window is re-scanned next pass. |
| Shared cursor at line N | scan reaches EOF with an unanswered call in the trailing suffix | held at that call's line | Self-heals once a later result pairs and pushes the tail boundary past it. |
| Skills high-water mark | any of the above | advances independently | Never constrained by the shared cursor. |

## Notable Behavior

- **The commit-time driver is the only one a terminal-only user has.** With no editor window open, the refresh tick never fires, so every reference and skill this host produces would otherwise be lost. This is why the pass is awaited on the commit path at all.
- **Two hookless sources now share one deadline instead of racing serially.** Previously each was awaited in its own race, so two three-second deadlines could consume six seconds of a user-waited window that every summary milestone also has to fit inside; a third source would have made it nine.
- **No plan scan, and that is a property of the host's data, not an omission.** There is no plan markdown in this host's transcript to find.
- **The skill scan runs even when the reference scan threw.** The two ride separate cursors, so there is nothing to keep aligned; skipping it would strand skill lines behind a reference-side failure.
- **A tool call past the cutoff is dropped rather than deferred, and its result is dropped with it.** Not stashing the call is what makes the result unmatchable — the same shape the block-pairing parser uses.
- **A result past the cutoff deletes its pending entry before dropping.** Without that ordering the call would look in-flight forever and pin the cursor at its line.
- **A result for an untracked call does not move the tail boundary.** Only a result that paired with something this scan is tracking counts as evidence that the stream has caught up.
- **The permalink map is always empty for this host.** The transcript format carries no pasted permalinks, so the one normalizer that consults the map can only ever resolve a link by reconstructing it from a configured workspace address.
- **The returned cursor mixes a 1-based count with a 0-based index.** The rewind branch returns a line index while the ordinary branch returns a traversed-line count; both are correct because the caller feeds the value back as a 0-based start line.
- **A caller only persists a cursor that moved strictly forward**, so a rewind landing on the window's own start line simply holds the cursor.
- **"All existing source definitions apply for free" is false.** Reusing the block-pairing agent's match table means a definition is reachable only if its declared tool-name shape can occur on this host; every definition scoped solely to the hosted connector namespace is a known gap, not a covered case. Note also where the mechanism is **not**: this parser's own gate is a bare MCP-server-prefix test that the connector namespace satisfies too, so nothing here rejects those definitions — they are simply never named by a tool call on this host. (Surprising; the shared-parser reuse invites exactly the opposite reading, and so does describing the split as a prefix check.)
- **The re-enable catch-up sweep cannot reach this source at all**, because it iterates the persisted session registry and nothing writes this source into it. The sibling hookless source, by contrast, is excluded from that sweep by an explicit name test — so the sweep's code reads as if hookless sources were enumerated there.
- **Both nested failure boundaries are needed.** The inner per-session catch keeps one unreadable transcript from aborting the batch and blocking every later session's cursor advance; the outer catch keeps configuration/discovery failures from breaking the never-rejects contract that both drivers rely on.

## Shared Behavior

- **Session discovery, working-directory recovery, the transcript layout, and conversation normalization** are owned by spec 339.
- **Skill invocation capture** — recognition, the pending/result fold, the independent high-water mark, and its own trailing-suffix rewind — is owned by spec 341.
- **The shared context-normalizer registry** invoked on each decoded payload, its closed membership, and its identity default are owned by spec 342.
- **The shared extraction pipeline** the reference scan runs inside — payload-tree walk, per-result containment, dedupe by registry key, per-reference markdown write and registry upsert under the registry lock, and per-reference failure isolation — is owned by spec 153, together with the arguments-derived allowance's contract and the tail-rewind rationale this parser mirrors.
- **Identity resolution semantics** (prefix, exact allow-list, accept-suffix, deny-suffix) are owned by spec 153; the per-definition match data is catalogued in spec 154.
- **The manually-disabled zero-write contract** is owned by spec 304.
- **The commit-time cutoff and its per-line stop semantics** are owned by spec 36.
- **The sibling hookless source's equivalent pass**, including its plan scan and the cursor capping that this source has no use for, is owned by specs 18, 180 and 181.
