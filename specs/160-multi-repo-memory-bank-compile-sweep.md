# 160. Multi-Repo Memory Bank Compile Sweep

## Topic Statement

Compile every discovered repository under the user's memory-bank parent folder in one coordinator pass that holds a single vault-write lock for the entire pass, isolates per-repository failures, and reports aggregated outcomes.

## Scope

**In scope:**
- The trigger surfaces that invoke a sweep (the bare command-line compile with no per-repository target, and the IDE "build knowledge wiki" toolbar surface).
- The pre-sweep configuration checks (credential availability, memory-bank parent configured) and the host-side re-entrancy guard that prevents concurrent sweep invocations within one host process.
- The **per-write** acquisition of the shared vault-write lock in bounded-wait mode, and the deliberate absence of any sweep-spanning lock (and therefore of any skipped-sweep outcome).
- The order of work in the sweep body: capture of the process-global active-storage override **and** of the process-global log directory, sequential per-target iteration, restoration of both in a guaranteed-cleanup tail.
- The per-target re-pointing of the log directory, so each swept repository's diagnostics land in its own log file.
- The optional progress callback the caller may supply, and the fixed phase-label message format the sweep emits through it.
- The per-target step sequence: build a folder-only storage rooted at the target's hidden-layer parent; install it as the process-global active storage; drain the topic-ingest pipeline for the target with the sweep-tagged trigger label and the freshly-built storage threaded as the read snapshot; render the visible wiki layer; build the knowledge graph; warm the local search index. The sweep runs **no** orphan-page purge.
- The per-target error envelope: any thrown error from any step of the per-target sequence is caught, stringified, and recorded against that target with zero-valued counts; the sweep continues to the next target.
- The non-fatal sub-error envelopes for the knowledge-graph build and the search-index warming inside one target's pass (a thrown error in either is logged and ignored without converting the rest of the target's pass into a failure).
- The result aggregation contract: per-target rows in discovery order, plus a sum of ingested counts and a count of failed targets.
- The storage mode applied to swept targets (folder-only; no version-controlled-ref backend is engaged).
- The host re-entrancy guard's bounded behavior and its informational message when a second invocation arrives while a first is still running.
- The user-visible reporting surface for each outcome shape (per-target lines, totals, failure count, exit code for the command-line surface; progress notification, summary message, and panel refresh for the IDE surface).

**Out of scope (boundaries):**
- Enumeration of compilable targets under the memory-bank parent folder, the rules that classify a child directory as compilable, the exclusion-pattern syntax, and the identity-labelling map (covered by the memory-bank folder layout spec, repository-discovery subsection).
- The per-repository ingest pipeline itself — batch routing, reconcile, processed-set bookkeeping, telemetry, and rebuild semantics (covered by the topic ingest pipeline spec) — and the orphan-page purge mechanics (covered by the topic index and page storage spec; the sweep never calls the purge). This spec invokes that pipeline once per target and threads a per-target read snapshot through; the pipeline's internals are not re-stated here.
- The trigger debounce / cooldown window that throttles event-driven ingest, and the recovery semantics when an enqueue fails (covered by the ingest trigger and cooldown spec). The sweep deliberately bypasses this window — it is manual on-demand and always runs to completion of its first lock attempt.
- The shape of the memory-bank parent folder, per-repository subdirectory, hidden machine-readable layer, and visible / wiki layers (covered by the memory-bank folder layout spec).
- The mechanics of the vault-write lock — file format, PID-aware reclaim, heartbeat, wait modes, and the typed busy signal a timed-out acquisition raises (covered by the vault-write lock spec). This spec only references how and when the lock is requested.
- The visible wiki renderer's manifest bookkeeping, hand-edit protection, and disk layout (covered by the visible / wiki layer specs).
- The local search index's storage and query mechanics (covered by the search-index specs).
- Credential resolution and underlying model-call protocol (covered by the credential-priority and LLM-routing specs); this spec only checks for credential presence before starting and reports a fixed error when none is available.
- The single-target compile entry point (this spec covers only the multi-target sweep coordinator; the single-target path is its sibling).
- Any sync engine activity; the sweep contends for the same lock the sync engine uses, but does not invoke sync.

## Data Contracts

### Sweep input

- **Memory-bank parent path** — the absolute filesystem path that contains the per-repository subdirectories. Sourced from the resolved user configuration.
- **Configuration record** — the resolved configuration document, which carries (in addition to credential fields read by the pre-sweep check) an optional **exclude list** of folder-name patterns used to skip per-repository subdirectories during discovery. An absent or empty exclude list excludes nothing.
- **Optional batch-size hint** — a single forwarded scalar passed through to the per-target ingest pipeline; it is not consumed by the sweep itself.
- **Optional progress callback** — invoked with one message string per phase milestone (see below). Absent by default; its absence changes no behavior.

### Sweep output (per-target row)

For every target the discovery layer returned, one row with:
- **Folder name** — the directory basename of the target under the memory-bank parent.
- **Repository identity** — an opaque label attached by the discovery layer when the cross-repository identity registry maps the folder name to one. Absent rows leave this unset.
- **Ingested count** — number of sources folded into the target's knowledge base on this pass. Zero on a failed target.
- **Batch count** — number of pipeline batches that ran. Zero on a failed target.
- **Error message** — present only when the target's per-target pass threw; carries the thrown error's message, or its string-coerced form when the throw was not an `Error`-shaped value.

### Sweep output (aggregate)

- **Per-target rows** — array in discovery order (the order returned by the repository-discovery layer; see boundary spec for that order).
- **Total ingested** — sum of the per-target ingested counts.
- **Failed count** — number of per-target rows that carry an error message.

There is **no** "skipped" field on the aggregate. A contended lock cannot prevent the sweep body from running, because no lock spans the sweep.

### Pre-sweep failures (no result shape)

Two pre-conditions can block the sweep before the lock is even attempted; both are reported as user-visible messages with no per-target rows:
- No credential available (no provider key in configuration, no environment override).
- No memory-bank parent folder configured.

### Host re-entrancy state

A host-process-scoped boolean ("a sweep is currently in flight"). Lives only for the duration of a single sweep invocation. Set true synchronously upon passing the entry checks, cleared in a guaranteed-cleanup tail after the sweep returns or throws.

### Process-global active storage override

A process-global value the per-target ingest pipeline and downstream stores consult when the caller does not pass an explicit storage object. The sweep captures whatever value is currently installed, replaces it once per target (so the target's pipeline observes its own folder storage), and restores the captured value in a guaranteed-cleanup tail.

### Process-global log-directory override

A second process-global value, handled identically and in the same guaranteed-cleanup tail as the storage override: the sweep captures the log directory as it stands on entry, re-points it at the current target once per target, and restores the captured value when the sweep body exits (normal or error).

Re-pointing it per target is what makes each swept repository's ingest and knowledge-graph diagnostics land in **that repository's own** log file rather than in one file belonging to the host process's working directory. Restoring it matters for the same reason the storage override is restored: in a long-lived host the override would otherwise leak past the sweep and silently misdirect every later log line to the last-compiled repository.

### Progress callback (optional, supplied by the caller)

The caller may pass a progress callback that the sweep invokes with a single human-readable string per milestone. The message format is fixed:

```
<phase label> — <folder name>
<phase label> — <folder name> (<detail>)
```

- Two phase labels are emitted per target, as **peers**: one covering ingest *and* the wiki render together, and one covering the knowledge-graph build. Ingest and render are deliberately a single user-facing phase — there is no separate "rendering" milestone.
- The optional parenthesised detail carries the graph build's own sub-progress, forwarded verbatim.
- There is **no** `[i/total]` counter in the message. A counter was removed because it read as a phase index and confused users; the phase label carries the meaning instead.

The callback is optional — a caller that omits it changes no sweep behavior. What the caller does with the string (a progress notification, a log line) is the caller's concern.

## Behavior

### Entry-point gating (both surfaces)

1. Load the resolved configuration.
2. **Credential check.** If no provider key is configured and no provider-key environment override is present, surface the credential-missing message and abort. The command-line surface additionally appends a credential-missing telemetry entry to the target's run history and sets a non-zero exit code. No lock is attempted, no discovery is run.
3. **Parent-folder check.** If no memory-bank parent folder is configured, surface the missing-folder message and abort. No lock is attempted, no discovery is run.
4. **Host re-entrancy guard** (IDE surface only). A second invocation arriving while the in-flight flag is set surfaces a "build already in progress" message and returns without entering the sweep body. The check-and-set is synchronous so two concurrent invocations cannot both pass. The command-line surface has no such guard because each command invocation is its own process; concurrency between two command invocations is gated solely by the vault-write lock.

### Lock model

1. Compute the canonical vault root from the configured memory-bank parent (the same derivation other vault writers use). The same lock serialises the background ingest worker, the sync engine, and any other sweep against the same memory-bank parent.
2. Build a **per-write guard**: each persistence step re-acquires the lock in bounded-wait mode, runs its write, and releases immediately. The model-bearing reconcile phase runs **unlocked**. A step whose acquisition times out receives a typed "busy" signal.
3. There is **no sweep-spanning acquisition** and therefore no contended-sweep outcome: the sweep body always runs, and two sweeps over the same memory-bank parent may overlap. That is safe under the drain's own optimistic-concurrency guards (topic pages re-read and compare before writing; the routing index and the processed-set are read-modify-written under the same guard), and at worst duplicates model work.

### Discovery

1. Invoke the repository-discovery layer with the configured memory-bank parent and the resolved exclude-pattern list (an empty list when the configuration does not carry one).
2. Receive a deterministic-ordered list of target descriptors, each carrying the folder name, the absolute hidden-layer parent path for that repository, and an optional identity label. See the memory-bank folder layout spec for the discovery rules.

### Override capture

3. Capture the process-global active-storage value as it stands at the start of the sweep body. Open a guaranteed-cleanup region that will restore this value when the sweep body exits (normal or error).

### Per-target iteration (sequential, in discovery order)

For each target descriptor in turn:

1. Re-point the process-global log directory at this target, then build a fresh folder-only storage rooted at the target's hidden-layer parent. **No version-controlled-ref backend is engaged for swept targets** — the sweep writes only the on-disk folder mirror.
2. Install that storage as the process-global active-storage override (so any downstream code that consults the override observes the current target's storage). Report the first phase milestone ("building the knowledge wiki") for this target through the progress callback when one was supplied.
3. Drain the topic-ingest pipeline for the target's hidden-layer parent with: the resolved configuration; the forwarded batch-size hint when present; the freshly-built storage threaded explicitly as the **read snapshot** so every read inside the pipeline observes one coherent view of the target; the per-write guard; and a fixed trigger label denoting a manual run.
4. Render the visible wiki layer for the target's hidden-layer parent through the freshly-built storage and the per-write guard. **No orphan-page purge runs here** — because the lock is released between writes, a concurrent ingest can add a topic page that is not yet in this sweep's index snapshot, and purging "everything not in the routing index" would delete it. Orphan pages from topic consolidation are reclaimed only by an explicit single-target rebuild, never by the routine sweep.
5. Report the second phase milestone ("building the knowledge graph") for this target, then build the knowledge graph for the target from its freshly-ingested knowledge base, through the freshly-built storage, forwarding the build's own sub-progress as the milestone's parenthesised detail. **This step is wrapped in its own nested error envelope** — any thrown error, including a missing credential, is logged at warn level and ignored. It runs **unguarded** (no lock held) because it is model-bearing: holding the vault lock across it would re-create the commit-blocking stall the per-write guard exists to remove. The graph is a derived artefact, rebuilt on the next sweep.
6. Warm the local search index by rebuilding it for the target's hidden-layer parent through the freshly-built storage, under one guarded write. **This step is likewise wrapped in its own nested error envelope** — any thrown error is logged at warn level and ignored; the rest of the per-target pass continues as if the warming step had succeeded. The warming sub-step's failure does NOT mark the target as failed and does NOT contribute to the failed count.
7. On normal completion of steps 1–6: append a success row carrying the folder name, the identity label (when present), the ingested count returned by step 3, the batch count returned by step 3, and no error message. Add the ingested count to the running total.

If any of steps 1–4 (i.e., any step other than the knowledge-graph build and the search-index warming) throws:
- Catch the error.
- Coerce the thrown value to a message: when it carries a string `message` field (`Error`-shaped), use that field; otherwise use the value's string coercion.
- Append a failure row carrying the folder name, the identity label, zero ingested, zero batches, and the coerced message.
- Increment the failed count.
- **Continue to the next target** — the sweep never aborts midway because one target failed.

Each of the two nested catches (knowledge-graph build, search-index warming):
- Logs at warn level with the folder name and the coerced error message.
- Does NOT append a failure row.
- Does NOT increment the failed count.
- Does NOT alter the success row that will be appended after step 7 — the target is reported as successful with its real ingested / batch counts.

### Override restoration

After the last target has been processed (or after the iteration aborts for a non-per-target reason — though none exists in the current flow), the guaranteed-cleanup tail restores **both** captured values: the active-storage override and the log directory, each to the value it held before iteration began. This restoration runs even when the sweep body throws.

### Result construction

Return the aggregate: the array of per-target rows in discovery order, the running ingested total, and the failed count.

### Lock release

Each guarded write releases the vault-write lock as its own wrapping context exits, regardless of normal completion or thrown error. No lock survives past an individual write.

### Reporting (command-line surface)

After the sweep returns:
- For each per-target row, print a per-target line distinguishing success from failure. A success line reads "`✓ <folder>: up to date`" when that target ingested nothing, and "`✓ <folder>: <ingested> new commit summary/summaries`" otherwise (noun pluralised on the count). A failure line reads "`✗ <folder>: <error message>`". After the per-target lines, print a single summary line that likewise branches on the aggregate total: when the total is zero, "`Done: all <N> repo(s) already up to date -- no new commit summaries to add`"; otherwise "`Done: added <total> new commit summary/summaries across <N> repo(s)`" — with a "`, <M> failed`" suffix when at least one target failed. The user-facing wording deliberately says "commit summaries" rather than the internal word "sources", and never renders a zero count as "0 sources".
- If at least one target failed: set a non-zero exit code. A zero-failed sweep returns success.

### Reporting (IDE surface)

The sweep runs inside a progress-notification context titled to indicate a knowledge-wiki build is underway; cancellation is disabled.

After the sweep returns:
- Surface an informational message that branches on the aggregate total, using the same "commit summaries" vocabulary as the command-line surface. When the total is zero: "Knowledge wiki already up to date — no new commit summaries to add (<N> repo(s))". Otherwise: "Knowledge wiki updated — added <total> new commit summary/summaries across <N> repo(s)" (noun pluralised on the count). Either form carries a parenthesised "(<M> failed)" suffix when at least one target failed.
- If the sweep itself threw (a non-per-target throw — this would only happen for a pre-discovery failure in the sweep body, which the current flow does not produce; the per-target catch absorbs the per-target throws): surface an error message carrying the thrown error's coerced message.
- **In every exit path**, the in-flight guard is cleared in the guaranteed-cleanup tail and the sidebar's memory-bank panel is refreshed so newly-built wiki content is visible.

### Configuration-driven paths

- **No exclude list**: every discovered target is processed.
- **Non-empty exclude list**: each entry is an exact name or `*`-wildcarded glob; targets matching any pattern are skipped at discovery time and never appear in the result. (Pattern syntax is defined in the discovery boundary spec.)
- **No batch-size hint**: the per-target ingest pipeline applies its own default.
- **No memory-bank-parent existence on disk**: the discovery layer returns an empty target list; the sweep runs to completion with empty rows, zero ingested, zero failed. This is a valid "fresh install, nothing to compile yet" outcome.
- **Credential discoverable only via environment override**: the credential-availability pre-check passes; per-target pipeline calls go through with that credential.

## State Transitions

The sweep observes / mutates four kinds of state:

### Host re-entrancy flag (IDE surface only)
- **Cleared → Set**: a sweep invocation passes the pre-checks and enters the sweep body.
- **Set → Cleared**: the sweep body exits (normal completion or thrown error).
- A second invocation in the **Set** state surfaces a "build already in progress" message and is a no-op; it never enters the body.

### Vault-write lock
- **Free → Held by one write → Free**: every guarded persistence step acquires, writes, and releases. The lock is held for the duration of a single write, never across the drain, the graph build, or the per-target loop.
- **Held by another writer → bounded wait → acquired, or typed busy signal**: a step that cannot acquire within the wait window receives a busy signal. In the sweep no such signal is fatal — it surfaces as either a per-target failure row (for a drain or render write) or a warn-and-skip (for the graph build or the search-index warm).
- There is no "sweep declined by the lock" transition, because no lock spans the sweep.

### Process-global active-storage override
- **(Previous value) → Target's folder storage**: at the top of each per-target iteration, the override is set to the current target's freshly-built storage.
- **Target's folder storage → Previous value**: in the guaranteed-cleanup tail after iteration ends, regardless of normal completion or error.
- The per-target intermediate values are never restored individually — only the value captured before iteration began is restored at the tail.

### Process-global log directory
- Follows the identical three transitions as the storage override, captured and restored in the same tail: re-pointed at each target on entry to its iteration, and returned to the entry value once at the end.

### Per-target on-disk state (per target)
- The per-target ingest pipeline, wiki render, knowledge-graph build, and search-index warming each mutate the target's hidden-layer or wiki-layer files according to their own specs. The sweep's only contribution is the ordering and the shared lock.

## Notable Behavior

- **One lock acquisition per write, not one for the whole sweep.** The vault-write lock is taken briefly around each persistence step and released immediately; the model-bearing reconcile phase runs unlocked. This reverses an earlier design that held the lock across the entire sweep: because the same lock serialises the background commit-summary worker, a multi-minute model-bearing sweep starved those workers — they timed out waiting and left their queue entries orphaned. Commit memory is high-priority and a "build wiki" may proceed slowly, so the sweep yields between writes. Correctness without the long lock comes from the drain's own guarded-write phase (topic pages re-read and compare before writing, so no clobber; the routing index and the processed-set are read-modify-written under the same guard, so no lost update), not from lock duration.

- **Two sweeps over the same memory-bank parent may overlap, and that is accepted.** Dropping the sweep-spanning lock removed the only mechanism that could decline a second sweep, so there is no "skipped" outcome anywhere in this contract. Overlapping sweeps are safe under the optimistic-concurrency guards above and merely risk redundant model work. The IDE surface's in-process re-entrancy guard remains what stops a double-clicked toolbar button; the command-line surface has no equivalent.

- **The sweep never purges orphan topic pages.** Purging "every page not in the routing index" is only safe when the index read and the deletions happen under one continuously-held lock; with the lock released between writes, a concurrent ingest could add a page absent from this sweep's snapshot and the purge would delete it. Orphan pages from topic consolidation are therefore reclaimed only by an explicit single-target rebuild. (Safety; a deliberate reversal of earlier unconditional-purge behavior.)

- **The knowledge-graph build runs unguarded and non-fatally.** It is model-bearing, so holding the vault lock across it would re-create the very stall the per-write guard removes; and it is a derived artefact, so a failure (including a missing credential) is warned and skipped rather than failing the target.

- **The lock is aware of crashed holders.** The underlying lock is process-aware and heartbeated: a process that crashed while holding it does not permanently wedge the next writer, and a write cannot have the lock reaped out from under it by a watchdog. The sweep relies on this property for every one of its brief acquisitions.

- **Per-target failures are isolated; the sweep never aborts midway.** A throw from any of steps 1–4 of a target's pass is caught at the per-target level; the failure is recorded against that target with zero counts and the loop moves on. There is no "stop on first failure" mode.

- **Search-index warming is doubly contained.** It is wrapped in its own nested catch INSIDE the per-target pass, so its failure cannot even mark the target as failed. Rationale: the index is a disposable cache; an environment lacking the indexing dependency, or a transient I/O error during the warm, must not turn an otherwise-successful compile into a failed one. The knowledge-graph build is contained the same way.

- **The trigger label for swept passes is "manual," not "sweep."** Sources observing the per-target pipeline's telemetry cannot distinguish a sweep-triggered run from a single-target user-initiated run; both are tagged identically as a manual run. This is a deliberate choice — the per-target pipeline's contract treats both as "user-initiated and not subject to the event-driven debounce."

- **Swept targets get folder-only storage, never the dual ref backend.** A target compiled by the sweep is a sibling repository under the memory-bank parent; the sweep has no working tree for it and no git checkout to drive ref operations against. The on-disk hidden-layer mirror is the only writeable storage during a sweep pass. The sibling single-target compile, by contrast, runs from inside a working tree and uses dual-write storage.

- **Per-repository diagnostics are a deliberate consequence of re-pointing the log directory.** Each swept repository's ingest and graph logs land in that repository's own log file, not in one aggregate file under the host process's working directory — which is what makes a per-repo failure diagnosable after the fact. The override is captured and restored in the same tail as the storage override, for the same anti-leak reason.

- **The progress callback carries phase labels, not a counter.** Ingest and the wiki render are surfaced as one phase and the graph build as its peer, so the caller's notification reads as two named phases on a named repository. An earlier `[i/total]` counter was removed for reading like a phase index. A caller that supplies no callback changes nothing about the sweep.

- **The process-global active-storage override is captured and restored, not unconditionally cleared.** A long-lived host process (the IDE) may have an active storage override set from a previous operation (or from its host startup); the sweep restores that value rather than clearing the override outright. Rationale: an unrelated long-lived host operation that depends on the override should resume reading from the override it expected after the sweep completes.

- **Discovery is not gated by any lock.** Because no lock spans the sweep, every invocation that passes the pre-checks performs the discovery walk and sees the target list. (Earlier behavior deferred discovery behind a sweep-spanning lock acquisition so a declined sweep did not pay the filesystem-scan cost; with no such lock, there is nothing to decline.)

- **Aggregated totals reflect only successfully-ingested counts.** A failed target contributes zero to the running ingested total even if the per-target pipeline had partially processed sources before throwing. The contract is "we report what we can attest to."

- **Host re-entrancy guard is IDE-only, and it is now the only guard against a duplicate sweep.** Two command-line invocations launched in parallel both pass their pre-checks and both run to completion, contending only on the brief per-write acquisitions; neither is declined. The IDE surface keeps its in-process flag because the toolbar button is easy to double-click and a second in-flight sweep is pure redundant model work.

- **Sweep error reporting at the IDE surface is two-tier.** A run that threw outside the per-target catch (no such path currently exists, but the surface is defensive) is reported as an error. A run that completed with per-target failures is reported as an informational message naming the failure count — the sweep itself succeeded, individual targets failed.

- **The sidebar / memory-bank panel is refreshed in a guaranteed-cleanup tail at the IDE surface.** The refresh runs whether the sweep succeeded, was declined by the in-process re-entrancy guard, or threw — so a partial sweep's visible-wiki updates are always reflected.

- **The command-line surface returns non-zero only when a target failed.** A sweep with zero discovered targets is success. A sweep with at least one failed target returns non-zero.

- **The non-Error throw shape is tolerated everywhere.** Both the per-target catch and the nested search-index catch coerce the thrown value with the same conservative rule: prefer a string `message` field when available, otherwise string-coerce the value. A thrown plain string is reported verbatim.

## Shared Behavior

- The shape of the memory-bank parent folder, per-repository subdirectory, hidden machine-readable layer, and the rules that classify a child as compilable (presence of the hidden-layer index document) are defined by the memory-bank folder layout spec. This spec invokes the layout spec's "multi-repo sweep" enumeration surface and consumes its deterministic-ordered output.
- The repo-by-repo work that each per-target pass performs — batch routing, reconcile, processed-set bookkeeping, telemetry, wiki render, and the "read snapshot" threading model — is defined by the topic ingest pipeline spec. The orphan-page purge is **not** part of that per-target work; the sweep never invokes it. This spec invokes that pipeline once per target with a freshly-built storage threaded as the read snapshot.
- The trigger-debounce / cooldown window that throttles event-driven ingest, and how it is bypassed by manual entry points, is defined by the ingest trigger and cooldown spec. The sweep is a manual entry point; it bypasses the debounce.
- The vault-write lock's file format, PID-aware reclaim, heartbeat, wait modes, the typed busy signal a timed-out acquisition raises, and which other operations contend on it are defined by the vault-write lock spec. The sweep acquires it per write in bounded-wait mode and never holds it across the per-target loop.
- The visible-wiki renderer's manifest bookkeeping, hand-edit protection, and per-target disk layout are defined by the folder-based summary storage spec and the memory-bank folder layout spec's wiki section.
- The credential-priority resolution and underlying model-call protocol are defined by the LLM credential priority and AI-provider selection spec; this spec only checks for presence.
- The single-target compile entry point, which uses dual-write storage and the same per-write bounded-wait guard, is the sibling of this sweep coordinator and shares the same inner sequence with two differences: it treats a busy guard on its rebuild reset as fatal, and on that rebuild path only it also runs the orphan-page purge. Its full behavior is its own spec topic (the ingest trigger and cooldown spec).
