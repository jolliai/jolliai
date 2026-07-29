# 305. Re-Enable Transcript Discovery Catch-Up

## Topic Statement

Re-run the incremental plan-discovery and reference-extraction pass over every session the project's own session registry still holds, starting from each session's frozen discovery watermark, so that a repository coming back from a manual opt-out recovers the plans and references authored during the window in which discovery could not run — including for sessions that will never see another agent turn. The drain is a single sequential pass with no work ceiling, per-session failure isolation, and one cursor write per transcript that actually had unscanned lines.

## Scope

**In scope:**

- The hole this pass exists to fill: which writers stop while a repository is opted out, and why the frozen watermark alone recovers some sessions but not all.
- Which surface actually invokes the drain, and which surface does **not** (a re-enable from the command line does not drain).
- The order of the whole-run steps: opt-out probe, session-registry load, one-time legacy-cursor fold, then the per-session loop.
- The per-session decision sequence: the polling-agent skip, the transcript-existence skip, the watermark read, the source-tag resolution, the two scans, and the gated cursor write.
- The exact condition under which the merged discovery cursor is advanced, and what is retried when it is not.
- Per-session failure isolation and whole-run fail-soft behavior.
- The returned count, what it counts, and who consumes it.
- The absence of any cap on sessions scanned or lines read per run, and what does bound the work.
- What a run with no backlog writes, and what it does not.
- The defensive opt-out guard at the top of the pass, and why it is not on any path the sole caller can reach.

**Out of scope (boundaries):**

- The per-turn incremental pass that the agent's own stop event drives for one transcript — the pass this drain imitates, including its single-owner gate and its own opt-out gate (spec 26).
- The plan scan itself: how each agent's transcript announces a plan, the external-plan exclusion policy, slug collision resolution, and the archived-plan revival guard (spec 29; the second agent's transcript variant and the polling agent's variant are spec 250 and spec 181).
- The reference scan itself: envelope parsing per producer, extraction, dedup, and reference persistence (spec 153, spec 154, spec 179).
- The polling surface this drain deliberately skips, including its own cursor-based recovery and its reversed scan order with a capped plan scan (spec 180; its session discovery is spec 18).
- The storage shape, key convention, atomic replacement, and orphan pruning of the cursor registry the watermark lives in (spec 24).
- The session registry's own format, write path, staleness threshold, and the orphan-cursor fan-out that pruning triggers (spec 23).
- The repository-wide opt-out flag's storage, repo-wide anchoring, priority, and migration (spec 145), and the in-memory zero-write gate whose **release** on the enable path is what makes this drain reachable at all (spec 304).
- Everything else the enable path does around this drain — hook and integration installation, storage-folder initialization and migration, panel refresh, cold-start recomputation (specs 57, 100, 144, 215).
- The plan-directory watcher's cross-project attribution rules (spec 113).

## Data Contracts

### Input

A single project-directory locator. Every read and write the pass performs is resolved relative to that directory's per-project state area, so the pass covers exactly the sessions recorded for that working tree.

### Session-registry fields consumed

The pass reads the project's session registry through the same reader every other consumer uses, which returns only the entries that are **not** stale by the registry's own age rule. Of each returned record it consumes exactly two fields:

| Field | Use |
| --- | --- |
| transcript locator | The file to scan; also the key under which the merged discovery watermark is read and written. |
| source tag (optional) | Decides two things: whether the session is skipped as belonging to the polling agent, and which per-source scanner/parser the two scans are asked for. An absent tag is treated as the first agent. |

The session identifier, the record's timestamp, and any recorded native title are not read. The registry is never written by this pass.

### Merged discovery watermark

One line count per transcript, in the merged plan-plus-reference cursor purpose (storage owned by spec 24). An absent watermark reads as line zero. This pass reads and writes only that merged purpose; it never reads or writes the separate summarization watermark, with one exception noted under the legacy fold below.

### Result

A single count: how many transcripts had their merged watermark actually advanced by this run. It carries no per-session detail, no list of failures, and no indication of how many sessions were considered or skipped. The pass resolves with this value in every case — including the opt-out short-circuit, a registry-load failure, and a run in which every session failed — and never rejects.

## Behavior

### Trigger and reachability

The drain is invoked from exactly one place: the editor extension's **Enable** command, and only on the branch where the install it wraps reported success. On that branch the command has already released the in-memory zero-write gate and attempted to clear the durable opt-out flag, and has already re-run the storage-folder initialization it may have skipped during a disabled start-up. The drain is then awaited — before the panels are refreshed, so freshly written plans and references are visible in the same gesture — and wrapped so that any escape is reported as a handled error rather than failing the enable.

There is **no other caller**. In particular:

- The command-line enable command does not invoke the drain. It installs hooks and clears the durable opt-out, and stops there. A repository re-enabled from the command line therefore **keeps** its frozen-window backlog: nothing re-reads the frozen suffix except a future turn in the same session, and a session that stays quiet loses whatever was authored during the window when the registry ages it out (spec 23) and its watermark is pruned with it.
- A repository re-enabled implicitly — for example by an activation-time auto-enable — does not drain either, and the auto-enable path is in any case gated on the opt-out flag being unset.
- No hook, worker, or non-editor surface calls it.

### The window the drain covers

While a repository is opted out, three independent facts combine to freeze plan and reference discovery:

1. The opt-out uninstalls the agent hooks from every working tree, so the per-turn pass (spec 26) is not invoked at all; and even where an entry survives on disk, that pass carries its own opt-out gate ahead of all its work.
2. The editor-side registration of a newly created plan file returns early on the in-memory gate. The directory watcher that feeds it keeps firing, but the creation events are one-shot and are never replayed after the gate is released — the watcher is subscribed once for the window's lifetime.
3. The per-turn pass is watermark-driven and advances the watermark only after a successful scan, so with no invocations the watermark stands still.

A frozen watermark is self-healing for **active** sessions: the next turn in the same transcript scans from the frozen line to end-of-file and therefore sweeps up the disabled window as a side effect. It is not self-healing for a session that produces no further turn — nothing ever re-reads that suffix. The drain exists for exactly that second class, and it treats both classes the same way (re-scanning an already-recovered suffix is harmless because both scans dedupe and upsert).

### Whole-run order

1. **Opt-out probe.** Read the in-memory repository-wide opt-out gate. If set, resolve with a zero count immediately — before the session registry is read and before any scan. See "Notable Behavior" for why this branch is not reachable from the sole caller.
2. **Load the pruned session registry.** On any failure, log a warning and resolve with a zero count. The underlying reader already flattens a missing or corrupt registry to "no sessions", so this guard is a second layer rather than the primary error path.
3. **One-time legacy-cursor fold.** Fold the two legacy purpose-prefixed watermark keys (one for the plan purpose, one for the reference purpose) into the single merged watermark, once per run — not once per session. The fold is idempotent and returns without writing when no legacy keys remain. It also ensures the per-project state directory exists. It is reached only when step 2 succeeded.
4. **Per-session loop** (below), in whatever order the registry enumerates its entries — there is no ordering by recency, and no session is prioritized.
5. **Summary log.** Emit one line naming the number of advanced watermarks **only when that number is non-zero**; a run that advanced nothing logs nothing at this level.
6. Resolve with the count.

### Per-session sequence

For each returned session record, in order:

1. **Polling-agent skip.** If the record's source tag (defaulting to the first agent when absent) identifies the on-demand polling agent, skip the session entirely. Two reasons hold, and both are real properties of that surface: (a) it drives its own recovery from the *same* merged watermark on its own recurring discovery tick, which also froze while disabled and therefore self-recovers on the first tick after re-enable; and (b) its scan order is the reverse of this one — it scans references first and then scans plans *capped* at the reference line — so a pass driven here would use a different, uncapped ordering against the same watermark.
2. **Transcript skip.** Skip the session if the locator is empty or the file does not exist on disk.
3. **Watermark read.** Read the merged watermark for that locator; absent reads as line zero.
4. **Source resolution.** The second recorded agent's tag passes through as itself; every other value — including an absent tag — is resolved to the first agent.
5. **Plan scan.** Scan from the watermark with **no upper line bound**, i.e. to end-of-file. A throw is caught and logged, and is remembered as "the plan scan did not complete". Its own reported line is not used.
6. **Reference scan.** Scan from the **same** watermark, also to end-of-file, and capture the line it reports as reached. A throw is caught and logged, and leaves the captured line at the starting watermark (the variable is seeded with it and only overwritten by a completed scan).
7. **Gated cursor write.** Persist the merged watermark at the reference scan's reported line **only if** the plan scan completed without throwing **and** that line is strictly greater than the starting watermark. When it is written, increment the count. Otherwise write nothing and leave the watermark where it was, so the whole window is re-offered on the next drain or the next agent turn.
8. **Isolation.** The entire per-session body is additionally wrapped, so a failure outside the two scans — for example a failing watermark read or a failing watermark write — is logged and the loop continues with the next session. One unusable session never aborts the batch and never blocks another session's advance.

### Branches

| Situation | Outcome |
| --- | --- |
| Opt-out gate set | Zero count; registry never read; no scan; no write. |
| Registry load fails | Zero count; no fold; no scan. |
| Registry empty or all entries stale | Zero count; the fold may still run; no scan. |
| Session belongs to the polling agent | Skipped before the existence check; not counted. |
| Locator empty or file absent | Skipped; not counted. |
| Both scans complete, reference line beyond the watermark | Watermark advanced to the reference line; count incremented. |
| Both scans complete, reference line equal to the watermark | No write; not counted (nothing new was in the file). |
| Plan scan throws, reference scan completes | Both outcomes logged; watermark **held**, so the plan window is retried; not counted. The reference work already performed is not undone. |
| Plan scan completes, reference scan throws | Watermark held (captured line never moved past the start); not counted. |
| Both scans throw | Both logged; watermark held; not counted. |
| Watermark read or write throws | Logged by the per-session wrapper; loop continues; not counted. |
| Any of the above | The pass still resolves with a count and never rejects. |

### Bounds, cost, and idempotence

There is **no cap of any kind** on a run: no maximum number of sessions, no maximum number of lines or bytes per transcript, no time budget, no early exit once some number of watermarks have advanced, and no batching across runs. Every eligible session is visited in one pass, and each of the two scans reads from the watermark to end-of-file. The only things that bound the work are:

- the per-transcript watermark, which is why the steady-state cost is the unscanned suffix rather than the whole file; and
- the session registry's own staleness rule, which is applied by the read the drain performs and therefore silently excludes sessions older than that threshold (spec 23). Sessions dropped that way are never drained, and their watermarks are pruned by the registry's own maintenance path rather than by this pass.

Consequently a long opt-out window over many sessions is paid in full, synchronously, inside the enable gesture the user just made.

The pass is idempotent. Re-running it immediately performs the same skips, re-reads the now-advanced watermarks, finds nothing beyond them, and writes nothing. A run with no backlog performs **no** plan-registry write, **no** reference write, and **no** watermark write. Two qualifications are exact rather than pedantic: the one-time legacy fold *does* write (both the merged document and the legacy document it removes the folded keys from) on the first run of a project that still carries legacy keys, and that same step ensures the per-project state directory exists.

## State Transitions

Per transcript, from this pass's perspective, the merged watermark moves through:

- **Frozen** — the value left by the last pass that ran before the opt-out. Reads as this value for the whole disabled window.
- **Frozen → Advanced** — one write, at the reference scan's reported line, when both gate conditions hold.
- **Frozen → Frozen (held)** — either scan threw, or the file had nothing beyond the watermark. Indistinguishable on disk from "never visited"; the window is simply re-offered next time.
- **Absent → Advanced** — a session whose transcript was never scanned before starts at line zero and is advanced in a single step to end-of-file.
- **Removed** — never by this pass. Only the registry's own stale-session fan-out removes a watermark (spec 23).

Per repository:

- **Opted out** → the frozen window accumulates unscanned lines and unregistered plan files.
- **Opted out → re-enabled from the editor** → the drain runs once; every eligible non-stale session's window is scanned and its watermark advanced.
- **Opted out → re-enabled from the command line** → no drain. Active sessions recover on their next turn; quiet sessions keep the backlog until they age out of the registry, at which point it is unrecoverable.
- **Re-enable failed** → nothing at all; the drain is not reached, and the opt-out stands.

The session registry itself has no transition here: the drain reads it, never writes it, and the staleness filtering it benefits from is applied in memory only — no pruned registry is persisted and no orphan watermark is cleaned up as a side effect of the drain.

## Notable Behavior

- **A command-line re-enable keeps the backlog.** The drain has exactly one caller, the editor's Enable command. The command-line enable path installs hooks and clears the durable opt-out without draining, so on that surface the recovery guarantee is only the weaker, pre-existing one: active sessions self-heal on their next turn, quiet sessions do not, and their content is lost once the registry ages them out. (Surprising; and note the pass's own inline documentation asserts that "the enable command calls this" without qualification — the tree does not support that reading of the command-line surface.)
- **The opt-out guard at the top is belt-and-braces, not behavior.** Its sole caller releases the in-memory gate earlier in the same success branch, so on that path the guard is always false when reached and its early return is never taken. It is also inert in any non-editor process, because those processes never set the in-memory gate at all. The only way it can fire is a user invoking Disable in the same window during the awaited work that sits between the release and the drain — an interleaving, not a designed path. Treat the guard as a second line of defense for the zero-write contract (spec 304), not as documented behavior of this pass.
- **The polling agent's skip is forward-looking.** No writer of the session registry records a session under that agent's tag today — the registry is written only by the two agent hooks that record sessions and by the plugin bootstrap, all of which tag their records as one of the two hook-recorded agents. The polling agent's sessions are discovered on demand and never persisted. The skip therefore guards a registry written by something other than today's writers; its two justifications (own-tick recovery, reversed and capped scan order) are nonetheless accurate descriptions of that surface. (Notable.)
- **The source distinction is inert in practice.** The pass faithfully passes through the second agent's tag, but both the plan scanner and the reference envelope parser resolve any tag other than the polling agent's to the *first* agent's implementation. Since the polling agent's sessions are the ones skipped, every session this drain actually scans is parsed by the first agent's scanner and parser regardless of its tag. (Surprising; harmless — the fallback parser simply finds nothing in a transcript it does not recognize.)
- **No per-integration configuration filter.** Unlike the per-turn pass (which returns early when its agent's integration is switched off) and unlike the polling surface (which returns early when its own integration is switched off), this drain never loads configuration. A repository whose first- or second-agent integration is explicitly disabled still has that agent's recorded sessions scanned, and its plans and references written, on re-enable. (Surprising; documented as found.)
- **The plan scan is uncapped here and capped on the polling surface.** Both scans read to end-of-file and only the reference scan's reported line becomes the new watermark, so the plan scan can process lines past the line the watermark is set to, and those lines are read again on the next pass. The polling surface deliberately caps its plan scan at the reference line to avoid exactly that churn; this pass mirrors the per-turn pass instead, which does not. Re-processing is safe because plan upserts are keyed and idempotent — it costs work, not correctness. (Surprising; deliberate mirroring of the per-turn ordering.)
- **The two scans' line counts are never reconciled.** The cursor target is whatever the reference scan reports. The plan scan's own reported line is discarded, and no check compares them.
- **The advance gate keys on the plan scan's completion, not on the reference scan alone.** Reaching end-of-file with references while the plan scan threw would, if the watermark advanced, strand that plan window permanently. Holding the watermark makes the next drain (or the next agent turn) re-scan it, and re-scanning is idempotent for both scans.
- **The count is advisory.** It is consumed only by the pass's own conditional summary log and by tests; the enable command awaits the pass and discards the value. Nothing in the product reports to the user how much backlog was drained, and a run in which every session failed is indistinguishable from a run with nothing to do (both resolve zero, and both stay silent at the summary level).
- **A drain failure never fails the enable.** The pass swallows everything internally, and the caller additionally routes any escape through its error handler. The enable command reports success, refreshes its panels, and moves on regardless.
- **The drain covers one working tree.** It reads the session registry of the directory it is handed, and that registry is per-working-tree. Other checkouts of the same repository keep their own frozen windows until they are themselves re-enabled from the editor — even though the opt-out flag that gated them is repository-wide.
- **Registry staleness is a silent data boundary.** Because the load applies the staleness filter, "the sessions this run can possibly recover" is strictly the recent ones. A window longer than that threshold is partially unrecoverable by construction, and nothing surfaces that fact.
- **The legacy fold runs once per run, not once per session.** The per-turn pass performs the same fold inside its single-transcript pass; here it is hoisted out of the loop, so a drain over many sessions pays it once. It is also the only step in the pass that can touch the legacy watermark document — it rewrites that document to drop the keys it folded, preserving every other entry in it.
- **Skips are ordered.** The polling-agent skip is evaluated before the transcript-existence check, so a skipped session never pays the filesystem probe.

## Shared Behavior

- The per-turn incremental pass this drain mirrors — its trigger, its own opt-out gate, its single-owner gate, its plan-then-reference order, and the identical advance condition — is defined by spec 26. This pass is deliberately the same pass driven over a batch instead of over one transcript, minus the single-owner gate.
- The plan scan (per-agent announcement recognition, external-plan exclusion, existence gate, slug collision handling, archived-plan revival) is owned by spec 29, with per-source variants in spec 181 and spec 250.
- The reference scan (per-producer envelope parsing, the source-agnostic extraction pipeline, dedup, and persistence) is owned by spec 153, with source adapters in spec 154 and persistence in spec 179.
- The merged watermark's storage shape, its key convention, the legacy purpose prefixes the fold consumes, atomic replacement, and the "advance only after successful processing" convention are owned by spec 24.
- The session registry that supplies the sessions, its staleness threshold, and the orphan-watermark pruning fan-out that eventually discards an undrained window are owned by spec 23.
- The polling surface this pass skips — its recurring tick, its own recovery from the same watermark, and its references-first, capped-plan-scan order — is owned by spec 180 (session discovery in spec 18).
- The in-memory zero-write gate whose release on the enable path makes this drain reachable, and the enumeration of the entry points that carry that gate, are owned by spec 304. The durable repository-wide opt-out flag behind it — storage, repo-wide anchoring, priority over every other signal, and the fact that only an explicit enable clears it — is owned by spec 145.
- The command-line enable command that does **not** drain is spec 57; the editor activation and auto-enable paths that likewise do not drain are specs 100 and 144; the storage-folder initialization the editor's enable re-runs immediately before the drain is spec 215.
- The editor-side plan-file registration that is gated during the window (and whose one-shot creation events are never replayed) is owned by spec 113.
