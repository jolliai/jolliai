# 180. Codex Reference Extraction via Polling

## Topic Statement

A background pass over each currently-recent Codex session's transcript extracts external-entity references (and shares its cursor with markdown-plan discovery), driven by the host UI's existing recent-conversations refresh timer rather than by any Codex-side lifecycle hook.

## Scope

**In scope:**

- The cadence at which the pass runs — a fixed-period background refresh ticked by the host UI's active-conversations panel — and the other call sites that opportunistically run the same pass.
- The cwd-resolution step that turns "this UI is open in workspace X" into "scan only Codex sessions attributed to workspace X".
- The per-cwd single-flight guard that collapses concurrent triggers, and the **dirty-rerun** flag that forces exactly one extra pass when re-entry happens during an in-flight pass.
- The contractual no-reject behavior: the pass never propagates an error to its caller, regardless of which sub-step fails, so callers may fire-and-forget it.
- The early-exit gates, in evaluation order: a "this project is manually disabled" check, a user-facing "Codex discovery is disabled" config bit, and a "Codex is not installed on this machine" probe.
- The one-shot legacy-cursor migration that runs once per pass before any session is scanned.
- The session-enumeration step that asks the Codex discovery layer "which Codex sessions are recent for this cwd?" and the per-session failure isolation that follows it.
- The dual-scan order — reference scan first, plan scan second — and the rule that the reference scan's "safe cursor" caps the plan scan's window.
- The third scan the same per-session loop runs (skill discovery), and the fact that it rides its own high-water mark **outside** the shared-cursor advance gate.
- The merged-cursor advance rule: advance only when both cursor-sharing scans completed and the safe cursor strictly moved past the previous cursor.
- The cursor-hold rule for in-flight requests, framed at this spec's level (what the reference scan promises and what this pass does about it).
- How this composes with the parallel commit-time reference-extraction path used by another producer that does have a lifecycle hook (failure-isolation, side-by-side coexistence, shared persistence).
- The end-to-end terminal outcomes of a single tick, including the no-op outcomes.

**Out of scope (boundaries):**

- The producer-specific envelope shape Codex uses for tool calls (the three-line `function_call` / `function_call_output` / `mcp_tool_call_end` correlation, the shell-CLI fallback, the substring pre-filter, the cutoff and in-flight rules inside the parser, the salvage path). Covered in **spec 153** (transcript reference extraction).
- The source-definition model (which payload shapes count as a reference, URL validation, archive-form round-trip) and its evaluation engine. The DSL and engine are **spec 255**; the built-in catalog — twelve sources: Linear, Confluence, Jira, GitHub, Notion, Slack, Zoom Meeting, Zoom Doc, Asana, monday.com, Context7, Jolli Memory (the last being self-referential rather than external) — is **spec 154**. Identity resolution — which source a Codex tool call belongs to — is a registry `match` over each definition's Codex match rule; per-source payload reshaping / malformed-output recovery / synthetic tool name remain in per-source Codex bindings looked up by the resolved definition's id. Those mechanics are **spec 153**.
- The session-aggregation layer that the host UI uses to render its active-conversations list and that defines what counts as a "recent" Codex session. Covered in **spec 155**. This pass relies on the same recent-session enumeration but does not own it.
- How Codex sessions are discovered on disk in the first place: the storage tree, the date-bucketed walk, the staleness window, the session-meta record, the working-directory match. Covered in **spec 18**.
- The on-disk shape of the per-reference markdown file and the per-project registry row that the persistence step writes. Covered in **spec 153** (registry lifecycle) and **spec 179** (markdown file format).
- The merged plan-discovery scan that walks the same transcript lines under the same shared cursor — its internal logic, its `apply_patch` parsing, the title-from-first-heading rule, the existence-on-disk guard, and the stale-source drop. Covered separately.
- The host-UI surface that hosts the refresh timer (panel visibility, sidebar lifecycle, webview message protocol, ticker pause-while-hidden). The pass is invoked from that surface but its own contract does not assume one.
- Authentication, rate-limiting, or any network call to Linear / Jira / GitHub / Notion themselves — the entire pass is a pure read of what the Codex agent already received and wrote to its transcript.
- The orphan-branch summary that takes a value-copy of each extracted reference into a commit summary once a related commit lands.

## Data Contracts

### Trigger input

The pass takes one input: a workspace cwd (absolute path string). All other inputs — config, installation check, the recent-session list — are read from durable state inside the pass.

### Trigger return

A promise that resolves with no value. The promise never rejects. Callers may `void` it.

### Per-cwd single-flight state

While a pass is running for a given cwd, the pass tracks:

| Field        | Type                       | Meaning                                                                                                       |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| in-flight    | promise                    | The promise the originating trigger returned. Subsequent triggers for the same cwd share this exact promise.  |
| dirty flag   | boolean                    | Cleared at the start of each inner pass; set to true by any re-entrant trigger; consumed at end of inner pass. |

The state is keyed by cwd. Different cwds run independently and may proceed in parallel.

### Per-session loop input

For each Codex session enumerated this tick, the pass needs:

| Field          | Type   | Meaning                                                                                                       |
| -------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| session id     | string | Opaque, used only for logging.                                                                                |
| transcript path| string | Absolute path to the session file. The unit the cursor keys on.                                              |

### Discovery cursor row

For each transcript path, persisted per project:

| Field          | Type    | Meaning                                                                                                      |
| -------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| transcript path| string  | The key.                                                                                                     |
| line number    | integer | 1-based count of lines that **both** the reference scan and the plan scan have safely processed past.        |
| updated at     | string  | ISO-8601 timestamp of the last advance.                                                                      |

The row is shared with markdown-plan discovery — one line number per transcript covers both scans. Absence means "never scanned"; on first read it resolves to line zero.

The same row additionally carries a map of **per-extractor** marks, one of which (`skills`) is read and advanced by the third scan below entirely independently of the line number above. This pass never reads or writes that map itself — it hands the whole concern to the skill-discovery driver. Its shape, its legacy-seeding rule, and its monotonicity are owned by **spec 24**.

### Reference-scan return

The shared cross-producer reference-extraction pipeline returns one integer to this pass: the "safe cursor", i.e. the 1-based line number that may safely be persisted as the new cursor for this transcript. The pipeline's own contracts (in-flight hold, payload walk, dedupe, upsert) are out of scope here; this pass uses only the returned integer.

### Plan-scan window

The plan scan is told to operate on lines `(fromLine, refLine]` — the exact window the reference scan has cleared this pass. The plan scan never sees lines beyond the safe cursor.

## Behavior

### Top-level trigger handling

1. Look up the in-flight state for the requested cwd.
2. If a pass is already in flight for this cwd:
   - Set its dirty flag to `true`.
   - Return the same promise the original caller received. No new pass is launched yet.
3. Otherwise:
   - Create fresh in-flight state for this cwd; record it before any I/O so concurrent calls see it.
   - Launch the outer dirty-rerun loop (below), attaching a finalizer that removes the in-flight state once the loop resolves.
   - Return the outer-loop promise.

The trigger function itself is synchronous up to returning the promise — it never `await`s before recording in-flight state, so the single-flight is honored even under stacked synchronous re-entry.

### Outer dirty-rerun loop

```
do
   set dirty flag to false
   run one inner pass
while dirty flag is true at end of pass
```

A re-entrant trigger between `dirty = false` and end-of-pass sets the flag, so exactly one additional pass runs after the current one. Re-entries during the additional pass are coalesced into the next iteration of the same loop; the flag is not a counter. The loop terminates when no re-entry occurred during the last pass.

This pattern exists because a naive single-flight would lose rows written to the transcript after the in-flight pass already consulted the recent-session list (or after it scanned a given session) — those rows would not be picked up until the next periodic tick, deferring extraction by up to one full refresh interval. The dirty-rerun makes the worst-case latency "one extra pass" instead of "one full interval".

### Inner pass

All work below runs inside a top-level try/catch. Any uncaught throw from config-load, installation probe, the migration, or the recent-session enumeration is caught at the top level, logged at warn, and swallowed — the inner pass resolves normally. This is the keystone of the "never rejects" contract.

Inside the try:

0. **Return immediately if the project is manually disabled.** This gate runs first, before the config read and before any other I/O. It is needed because the host UI's refresh tick keeps firing while a disabled panel is shown, and a pass that ran would persist cursors, plans, and references into the project's local jollimemory directory — writes a disabled project must not receive. The zero-write contract this upholds is owned by **spec 304**.
1. **Load config.** If the user-facing "Codex enabled" bit is explicitly `false`, return immediately. An absent or undefined bit is treated as enabled (default-on).
2. **Probe installation.** Ask the Codex installation check ("is Codex installed on this machine, with at least one recent session?") — if the answer is no, return immediately. This is the gate that lets the pass be wired unconditionally into the host UI without paying I/O for users who have never run Codex.
3. **Run the legacy cursor migration.** A one-shot, idempotent fold of any historical prefixed cursors (from a prior schema where plan and reference each had their own cursor) into today's merged discovery cursor. Idempotent — a no-op once already migrated. Failures here propagate up to the top-level catch and abort this tick.
4. **Enumerate recent Codex sessions for this cwd.** This call is owned by spec 18 (and surfaced by spec 155); this pass uses only its returned session list.
5. **For each session, in list order, run the per-session loop** (below). Sessions are processed serially within a tick: see "Why serial" under Notable Behavior.
6. Inner pass resolves.

### Per-session loop

Each session's processing is wrapped in its own outer try/catch. A throw at this level — including any throw escaping the inner try/catches around the two scans — does not abort the per-session loop; it is logged at warn (with the session id and error message) and the next session is processed normally. This is the failure-isolation that makes "one corrupt transcript" recoverable without losing the rest.

Inside the per-session try:

1. **Load the discovery cursor** for this transcript path. If none exists, treat the from-line as zero. Reading a corrupt cursor file falls through to the top-level catch (the migration step would have triggered the same failure earlier; this is defensive).
2. Initialize `refLine = fromLine`, `refDone = false`, `planDone = false`.
3. **Reference scan (first):**
   - Call the shared reference-extraction pipeline for this transcript, starting at `fromLine`, with the producer tag set to "Codex".
   - The pipeline returns its safe-cursor integer; assign it to `refLine` and set `refDone = true`.
   - If the pipeline throws, catch the throw inside this step's try/catch; leave `refLine === fromLine` and `refDone === false`; log the failure at warn (session id + message) and continue to step 4.
4. **Plan scan (second):**
   - Call the shared markdown-plan discovery for this transcript, starting at `fromLine`, with `refLine` as the **upper bound** on lines the plan scan is allowed to consume (so the plan scan never processes lines the reference scan deliberately held).
   - On success set `planDone = true`.
   - If the plan scan throws, catch inside its own try/catch; leave `planDone === false`; log at warn (session id + message) and continue to step 5.
5. **Skill scan (third):**
   - Call the shared skill-discovery driver for this transcript with the producer tag set to "Codex". It is handed **no** from-line: it reads and advances its **own** per-extractor mark inside the same cursor row (spec 24), independently of `fromLine` and `refLine`.
   - It never throws — it absorbs its own failures and leaves its mark unadvanced so the next tick retries the same window — so this step has no try/catch of its own and contributes nothing to `refDone` / `planDone`.
   - The scan sits inside the per-session loop but deliberately **outside** the shared-cursor advance gate below, in both directions: a skill scan that failed cannot hold the shared cursor, and a reference or plan scan that threw cannot hold the skills mark. Codex skill capture is heuristic (a shell read of a `SKILL.md`) and idempotent by name, so a re-scanned window costs work, not correctness. What it recognizes and what it writes are owned by **spec 326**.
6. **Cursor advance.** Save the cursor for this transcript **iff all three** hold:
   - `refDone` is true (reference scan completed normally), AND
   - `planDone` is true (plan scan completed normally), AND
   - `refLine` strictly greater than `fromLine` (the safe cursor actually moved).
   The saved row carries `lineNumber = refLine` and `updatedAt = now`. If any condition fails, the cursor is **held** — no change is persisted, so the next tick rescans the same window. Re-scan is idempotent (the persistence step is keyed by stable identifiers and gated on byte-equality), so a held window simply retries without producing duplicates. The skills mark is not part of this write and is not part of this condition.
7. Per-session loop completes. The next session begins.

### What "safe cursor" implies for in-flight requests

The shared reference pipeline for Codex transcripts deliberately does **not** advance past a Codex tool-call request whose result line has not yet been written to the transcript. The pipeline's returned safe-cursor is at most the request line's index. This pass simply uses that integer; it does not know **why** the cursor was held.

Consequence: a request that straddles two ticks (request line on disk, result line not yet on disk) will be re-read every tick until its result lands. Once both halves are present, that tick's reference scan returns a safe cursor past the now-completed request, and the cursor advance fires. The plan scan, having been capped at the same line, never sees a markdown plan that "lives" past an in-flight request — so plan extraction does not race ahead of reference extraction on the same call boundary.

### Composition with the lifecycle-hook path

A separate producer (the one with a usable Stop-style hook) drives the same reference-extraction pipeline at commit-time, with no recency-based polling. The two paths coexist without coupling:

- Both paths call the same persistence step; the shared registry is keyed by stable map keys, so a reference discovered by both paths upserts the same row.
- The two paths share **no** in-flight state. The polling pass's per-cwd single-flight does not gate the hook path, nor vice versa.
- Failure in one path does not affect the other. A throwing Codex pass logs and swallows; a failing hook follows its own owner's contract.
- Both paths share the discovery cursor table per transcript path; a Codex transcript and a hook-driven producer's transcript live under different keys (each producer uses its own transcript path).

### Why this path is polling rather than a hook

The hook-driven producer's lifecycle hooks live in agent configuration the user explicitly trusts. The Codex lifecycle-hook surface has constraints that make it unusable for this product: trust must be granted per-user (a one-time consent dialog from the agent each time), and the hook does not currently fire reliably across git-worktree-based checkouts of the same repository. Polling avoids both constraints — the host UI already enumerates recent Codex sessions for its own active-conversations panel, so reusing that enumeration as the trigger costs only the per-session scan time, paid once per refresh interval.

### Outcomes of a single tick

A tick resolves with one of the following terminal outcomes:

| Outcome                                        | Cursor effect                                          | Side effects                                              |
| ---------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Project manually disabled                      | None for any transcript                                | None — not even the config read                           |
| Codex disabled in config                       | None for any transcript                                | None                                                      |
| Codex not installed                            | None for any transcript                                | None                                                      |
| Recent-session enumeration threw               | None for any transcript                                | Single warn log                                           |
| No recent sessions                             | None                                                   | None                                                      |
| Session: ref-scan threw                        | Cursor held for that session                           | Warn log; plan scan still runs over zero-width window     |
| Session: plan-scan threw                       | Cursor held for that session                           | Warn log                                                  |
| Session: both scans clean, `refLine > fromLine`| Cursor advanced to `refLine`                           | Persist step's logs (upsert N of M, file writes)          |
| Session: both scans clean, `refLine == fromLine`| Cursor held                                            | No persistence (zero references, idempotent re-read)      |
| Session: per-session try/catch caught any other throw | Cursor held for that session                     | Warn log; next session still processed                    |
| Session: skill scan found new lines             | Shared cursor unaffected; the session's `skills` mark advances | Skill working-record writes (spec 326)   |
| Session: skill scan failed internally           | Nothing advances for it; shared cursor decision unaffected | Its own warn log; loop continues        |

## State Transitions

### Per cwd

```
idle
  │
  │ trigger arrives
  ▼
in-flight (dirty=false) ──────────┐
  │   ▲                           │
  │   │ re-entrant trigger        │
  │   │ sets dirty=true,          │
  │   │ shares the same promise   │
  │   │                           │
  │   └──────────────────────┐    │
  ▼                          │    │
inner pass completes         │    │
  │                          │    │
  ├── dirty == true ─────────┘    │
  │                               │ outer loop exits
  │                               ▼
  └── dirty == false ─────► finalizer removes in-flight state ─► idle
```

### Per (transcript, tick)

```
                    fromLine = saved cursor (or 0)

ref-scan throws ──────────► refLine := fromLine, refDone := false
   │
   └─ plan-scan window is (fromLine, fromLine] (empty)

ref-scan returns refLine ──► refDone := true
   │
   ▼
plan-scan throws ──────────► planDone := false ──► cursor HELD
plan-scan succeeds ────────► planDone := true
                              │
                              ▼
                         refLine > fromLine ?
                              │    │
                            yes    no
                              │    │
                              ▼    └──► cursor HELD (re-read next tick is idempotent)
                          cursor SAVED at refLine
```

## Notable Behavior

- **Pass never rejects.** Every trigger returns a promise that resolves successfully regardless of which sub-step fails. This is a hard contract: every call site is a fire-and-forget, and an unhandled-rejection from this path would surface as a host-UI crash.
- **Top-level guard catches the pre-loop steps.** Config-load, installation probe, the legacy cursor migration, and the recent-session enumeration all run before the per-session loop; a throw from any of them is caught at the top level (one warn log, pass resolves) rather than per-session. Per-session try/catches only protect work that begins after the session list is known.
- **The manual-disable gate precedes even the config read, and this pass is deliberately excluded from the re-enable drain.** The tick that drives this pass is not itself paused while a project is disabled, so the gate has to live at the head of the inner pass rather than at the trigger. On re-enable there is a one-shot catch-up pass that drains the backlog agent-hook-recorded sessions accumulated while disabled — and it **skips this producer's sessions on purpose**, because this tick's own cursor also froze while disabled, so the next tick after re-enable re-reads the same window and self-recovers. Running both would duplicate the work and invert this pass's references-first scan order. That catch-up is owned by **spec 305**.
- **Per-session try/catch is the failure isolation unit.** One transcript that can't be read (permission denied, FIFO/socket, partial line, parser bug) cannot abort the rest of the tick or block other sessions' cursors from advancing.
- **Dirty-rerun trades one extra pass for one full refresh interval of latency.** Without it, any work that lands on disk between "we asked for the recent-session list" and "we finished scanning the last session" would defer until the next tick. With it, the worst-case latency is one extra inner pass — typically much shorter than the configured refresh interval.
- **Single-flight is per-cwd, not per-session.** Two ticks for the same workspace coalesce. Two ticks for different workspaces (e.g. a multi-root host UI variant, or two independent host processes) run independently.
- **Default config-on.** A user with no config file has Codex extraction enabled. Only an explicit "off" disables this path.
- **Installation gate is cheap.** Users with no Codex installation skip every subsequent step. Wiring this pass to a periodic tick has no observable cost for non-Codex users.
- **Migration runs every tick but does work only once.** The legacy cursor migration is idempotent — a no-op once already done — so paying the (load + check) cost per tick is acceptable and saves a separate first-run code path.
- **A third scan rides this loop but not this cursor.** Skill discovery runs per session, after the plan scan, against its own per-extractor mark in the same row. It is deliberately outside the advance gate in both directions — a failed skill scan cannot hold the shared cursor, and a failed reference or plan scan cannot hold the skills mark — because the skills backlog is its own window and, on an upgrade, one the shared cursor may already have passed. It also never throws, so it needs no try/catch at this call site. (Surprising; see spec 24 for the mark and spec 326 for the scan.)
- **Cursor advance requires both cursor-sharing scans to complete cleanly.** A reference-scan-succeeded / plan-scan-failed tick **holds** the cursor. The reference scan's safe cursor is not separately persisted; only the merged "both completed" advance writes the cursor file. This is intentional: separating the advance would let plan extraction permanently lag reference extraction on a transcript whose plan scan keeps throwing.
- **`refLine == fromLine` holds the cursor.** A successful pass that produced no progress (typical when a transcript ends with an in-flight request, or when nothing new has been written since the last tick) does not rewrite the cursor file. This avoids needless writes — file watchers don't churn on a no-op tick.
- **`refLine === fromLine` after a ref-scan failure makes the plan scan trivial.** Setting `refLine = fromLine` after a thrown ref-scan means the plan scan is asked to operate on the empty range `(fromLine, fromLine]`. The plan scan returns immediately without modifying any state, and the cursor stays held — the same window retries together on the next tick.
- **Cursor reads / writes are per-transcript.** Two sessions for the same workspace each have their own cursor; advancing one does not advance the other.
- **In-flight cursor hold is enforced by the reference pipeline, not by this pass.** This pass only consumes the safe-cursor integer the pipeline returns. The "do not advance past an in-flight request" promise belongs to spec 153.
- **Only Zoom Doc is unreachable on this path.** Zoom Doc's source definition declares no Codex match rule at all, so it is never matched — a Codex polling tick can never persist a Zoom-doc reference; it remains Claude-only (specs 153, 154). Slack is reachable here: its definition declares a Codex match rule and has a registered Codex normaliser that resolves the thread url from a Codex-side pasted-permalink harvest plus workspace-address fallback (spec 256) — in practice its thread is delivered on the fallback event pass rather than the primary pass. monday.com is likewise Codex-reachable on this path, gated on the tool call's `itemIds` input (a board-browse call with no `itemIds` voids; spec 154). Jolli Memory is the eleventh and newest Codex-reachable source, and the **second** whose normal Codex delivery is the fallback event pass — for the same structural reason Context7's is (next bullet), not a new one: it is a *locally-registered* MCP server, whose request line carries neither the connector-app namespace nor a prefixed tool name and so is dropped by the line pre-filter. It is the stronger case of the two: Context7 *can* run as a hosted connector and take the primary path, whereas this source registers only locally, so its declared primary path has no configuration in which it fires. Where it does break new ground is the match gate: because its tool names are bare, its definition additionally pins itself to the server name the event reports (spec 153) — otherwise another local server's identically-named tool would resolve to it.
- **Context7 was the first source whose *normal* Codex delivery is the fallback pass for a structural reason rather than a retry reason; Jolli Memory is the second, on the same structure.** Slack rides the fallback pass because its primary attempt voids on an unresolved link and gets retried — a retry reason. Context7 rides it because it typically runs as a **local** documentation server rather than a hosted connector, and Jolli Memory because it is *always* a local server: the parser's Codex line pre-filter needles are hard-coded and all four are connector-oriented, so a local server's request line contains none of them and is discarded before parsing. Only the redundant end-of-call event line survives, and that line is self-sufficient — it carries the invocation's own arguments, which is all either source needs (both are arguments-derived; spec 153). Each declares a connector-app primary path that is code-reachable but has no observed real-world envelope.
- **An in-flight locally-registered-server call never pins the Codex safe cursor.** This is true of **both** locally-hosted sources — Context7 run locally, and Jolli Memory — for the identical reason, so it is no longer a property of one source. The in-flight hold only considers requests it can resolve, and resolving one requires the shared connector-app namespace; a locally-registered server's request line does not carry it, so that line is dropped by the parser's line pre-filter before it is ever indexed as a request and there is nothing left to hold on. It does not need to be held: unlike the Claude path, where an arguments-derived call's arguments exist only on the request line, the Codex event line is self-sufficient, so nothing is lost by advancing past the request. This is the mirror image of the Claude-side tail rewind (spec 153).
- **The salvage/recover hook is used by exactly one binding.** Only the Jira Codex binding declares the malformed-output recovery hook (its heavy-expand primary output is sometimes invalid JSON yet the only copy carrying the tenant URL); every other Codex source, including Zoom Meeting whose primary output is also frequently malformed, relies on the parser's plain redundant-event fallback because that event already carries a complete, valid payload. This mechanic lives in spec 153; noted here because it is Codex-only.
- **The plan scan is window-capped, not synchronized.** The plan scan is told its upper bound and is otherwise independent of the reference scan. It does not consult any reference-scan state. This is what lets a plan written by a Codex `apply_patch` whose request line straddles the cursor hold not be processed prematurely (it lives past `refLine` until the in-flight request's result lands).
- **Why serial per-session.** Sessions are processed one at a time so per-session cursor writes never race within a tick. Two parallel scans of two different transcripts could race on the cursor file under contention — making them serial removes that class of bug at the cost of a per-tick scan-time that is bounded by recency-window × small-session-count.
- **The host UI fires this pass on every refresh tick AND on several opportunistic events.** The single-flight collapses tick / panel-reopen / manual-refresh / detail-panel-save into one in-flight pass — the dirty flag then ensures any state change those opportunistic events imply is picked up by an extra pass rather than deferred.
- **The hook-driven producer's path is unaffected by this pass.** They share the persistence step (one upsert per reference, keyed by stable identifier) and the cursor file (one row per transcript, keyed by transcript path) — but transcript paths differ per producer, so there is no cross-producer contention on cursor rows. Failure isolation between the two paths is total.
- **`Codex enabled = false` is a kill switch, not a pause.** While set false, no Codex transcripts are scanned; references that would have been discovered are missed until either (a) the bit is flipped back to true, at which point the next tick rescans every recent Codex transcript from its persisted cursor, or (b) the related commit lands through a non-Codex producer path (which would not pick up Codex's tool-call mentions either way).

## Shared Behavior

- **The reference-extraction pipeline itself** — envelope parsing, source recognition, payload walking, dedupe, in-flight cursor-hold, persistence — is owned by **spec 153**.
- **The source-definition DSL and evaluation engine** the pipeline evaluates are owned by **spec 255**; the built-in catalog is **spec 154**. On the Codex path, **eleven** of the twelve sources are reachable — Linear, Jira, GitHub, Notion, Zoom Meeting, Confluence, Asana, monday.com, Slack, Context7, and Jolli Memory — because each declares a Codex match rule AND has a registered Codex normaliser. Only **Zoom Doc** is NOT reachable via Codex: it declares no Codex match rule at all, so a Zoom-doc tool call is never even matched on this path. (Slack was Codex-unreachable in a prior revision, for want of a registered Codex normaliser; that gap is now closed — spec 256.) Zoom-doc references are produced only on the Claude path (specs 153, 154). This pass therefore never yields a Zoom-doc reference regardless of what a Codex transcript contains.
- **The track-only carve-out downstream of this pass** — a Context7 reference is persisted, archived, and displayed exactly like any other reference this pass produces, but never reaches the summarization prompt block and never enters the relevance ranker's input. That is owned by **specs 12 and 258**; this pass draws no distinction and applies no filter of its own.
- **The recent-Codex-session enumeration** this pass uses to choose which transcripts to scan is owned by **spec 18** (the discovery walk) and surfaced by **spec 155** (the active-session aggregator that drives the host UI).
- **The merged plan-discovery scan** that walks the same transcript lines under the same cursor — its parsing of `apply_patch`, its on-disk existence guard, its title derivation — is owned by a separate plan-discovery spec.
- **The cursor file format and locking** — the shared `discovery-cursors` table, its per-extractor marks, and the legacy migration's idempotent fold rule — are owned by **spec 24**.
- **The third scan this loop runs** — Codex skill inference from a shell read of a `SKILL.md`, its `heuristic` detection stamp, and what it writes — is owned by **spec 326**, with the working record it upserts into owned by **spec 319**.
- **The host-UI refresh timer** (its interval, its visibility-gated pause, its message-protocol envelope to the webview) is owned by the sidebar specs.
- **The commit-time hook path** that drives the same reference-extraction pipeline for a different producer is owned by the hook-recording spec for that producer.
- **The manually-disabled zero-write contract** that this pass's first gate upholds is owned by **spec 304**; the one-shot re-enable catch-up that deliberately excludes this producer is owned by **spec 305**.
- **The orphan-branch snapshot** that takes a value-copy of each discovered reference into a commit summary once the related commit lands is owned by the summary-storage specs (01–06).
