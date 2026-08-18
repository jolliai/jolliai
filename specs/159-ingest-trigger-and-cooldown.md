# 159. Topic-KB Ingest Trigger and Cooldown

## Topic Statement

A repo-wide topic-knowledge-base ingest is enqueued at most once per cooldown window per project, with a force-bypass for merge events, a manual command-line surface that drains a single repo or sweeps all knowledge-bank repos, and a recovery rule that never burns the cooldown on a failed enqueue — **and, ahead of all of it, a configuration mode that by default stops every automatic trigger from enqueueing anything at all.**

## Scope

**In scope:**

- The per-project cooldown record: how it is read, how it is updated, the window length, the timestamp format, and the parsing tolerance for malformed values.
- The enqueue function called by every automatic trigger: cooldown check, force bypass, the queue write contract it delegates to, and the cooldown update ordering.
- **The rebuild-mode gate that now stands in front of every automatic trigger**, where it sits, and why the default value inverts what this topic used to describe.
- The trigger-source tag attached to each enqueued operation and carried through to telemetry.
- The non-throwing contract: every failure path returns a falsy "not enqueued" outcome and leaves the cooldown record unchanged.
- The command-line ingest entry point and its two modes — single-repo drain and all-repos sweep — together with their flag matrix, exit codes, output lines, credential precondition, and serialisation lock.
- The `--rebuild` reset of the high-water mark and routing index before a single-repo drain.
- The pre-drain credential check on the single-repo command path and the bookkeeping entry it appends when no credential is configured.

**Out of scope (boundaries):**

- The pipeline that consumes an enqueued ingest operation: batching, model calls, page reconciliation, per-topic failure isolation, telemetry record content, and outcome-code derivation are owned by the topic-ingest-pipeline spec (152). The orphan-page purge is **not** part of that pipeline — this command path is its only caller, and the condition under which it runs is specified here. This spec only states what is sent across that boundary (a tagged repo-wide ingest request) and what comes back (a result envelope summarised onto the console).
- The all-repos sweep's repo-discovery walk, per-repo storage construction, per-repo failure isolation pattern, and process-global storage override are owned by the multi-repo-compile-sweep spec (160). This spec only describes the entry point that delegates to it, the preconditions checked before delegation, and the exit-code contract.
- The queue worker that drains enqueued operations, its file lock, chain-spawn behavior, and ordering of mixed commit/ingest entries are owned by the git-operation-queue-worker spec (34). This spec only describes what the trigger writes to the queue, not how the queue is drained.
- The triggers themselves — what calls the enqueue function — are owned by their respective hook specs (post-commit hook chain-trigger, post-merge hook, etc). This spec describes the trigger contract; the call sites are specced where the events originate.
- The visible-wiki render that runs after a successful drain on the command-line path is owned by the topic-ingest-pipeline spec.
- The lock that serialises a manual drain against background workers and sync is owned by the vault-write-lock spec; this spec only describes that both entry points acquire it per write in bounded-wait mode, which single step treats a busy acquisition as fatal, and the user-visible message on that contention.
- The credential resolution chain itself is owned by the LLM credential priority spec (10). This spec only describes the boolean precondition ("any credential present") and the error message displayed when none is present.

## Data Contracts

### Cooldown record

A single per-project JSON object persisted in the project's local jollimemory directory under a fixed filename. The object has one optional field: a most-recent ingest timestamp as an ISO-8601 string. A missing file, a missing field, a non-object root, a JSON array, and any unparseable timestamp are all treated as "no cooldown" — equivalent to the field being absent.

The file is written atomically (temp file plus rename) so a partial write cannot be observed.

### Enqueued ingest operation

A small JSON object placed on the unified per-project operation queue:

- **Operation kind** — a fixed string discriminator distinguishing this from commit-type queue entries.
- **Trigger tag** — one of an enumerated set of trigger sources: post-commit chain trigger, post-merge, recall-miss, manual command-line. The tag is telemetry-only — it does not change pipeline behavior, only the value recorded against the eventual run.
- **Created-at timestamp** — ISO-8601 instant captured at enqueue time. Used by the queue worker for ordering.

The operation has no branch field because the topic knowledge base is repo-wide, not per-branch.

### Cooldown window

A fixed five-minute window measured from the most-recent successful enqueue timestamp. A trigger is "within the cooldown" when the difference between the current time and the recorded timestamp is strictly less than the window. Equal-to-the-window is "out of cooldown".

### Telemetry bookkeeping entries

The trigger layer writes one bookkeeping entry on the credential-missing precondition path of the single-repo command: an entry tagged with the trigger source `manual`, zero-duration, with a credential-missing outcome code, zero batches, zero sources, zero touched topics, zero route calls, zero reconcile calls, and an empty per-topic-failure list. The entries are appended to a bounded ring buffer (most recent N kept, older entries evicted). The bookkeeping format and ring-buffer cap are owned by the same telemetry store that the pipeline writes its own per-run entries through.

A corrupt or non-array ring-buffer file is treated as empty; the next append writes a single-element array.

### Command-line surface

The ingest command accepts:

| Flag | Accepted form | Default | Effect |
|------|---------------|---------|--------|
| Single-repo working directory override | Absolute or relative path string | Unset | Switches from sweep mode to single-repo drain mode; the path is the repo to drain |
| Rebuild | Boolean flag | Off | Resets the high-water mark and routing index before the drain. Valid only with the working-directory override; rejected otherwise |

With neither flag, the command sweeps every repo under the configured knowledge-bank folder.

### Exit codes (command-line)

- 0 — successful sweep (any per-repo failures still produce a non-zero exit, see below), or successful single-repo drain — including one where a derived-layer step (purge, wiki render, knowledge graph, search-index warm) was skipped after a non-fatal failure.
- 1 — any of: missing credential, missing knowledge-bank folder configuration (sweep mode only), the serialisation guard busy on the `--rebuild` reset (single-repo mode only), `--rebuild` supplied without the working-directory override, at least one per-repo failure during a sweep.

## Behavior

### Cooldown check

Given a project working directory and an optional "now" instant (defaulting to the current time), the cooldown check:

1. Reads the cooldown record. Any read or parse failure resolves to an empty record.
2. If the record has no most-recent timestamp, the check returns "not in cooldown".
3. Parses the timestamp. A parse failure (resulting in a not-a-number millisecond value) returns "not in cooldown" — a malformed record never blocks a trigger.
4. Returns "in cooldown" when the elapsed time since the parsed timestamp is strictly less than the five-minute window.

### Cooldown update

Updating the cooldown record:

1. Ensures the project's local jollimemory directory exists.
2. Writes an object containing a single field — the supplied instant formatted as ISO-8601 — atomically to the cooldown file.

The update never reads the existing record; the new value fully replaces it. There is no concept of "extending" or "resetting back" the cooldown — every successful update is a full write of one timestamp.

### The rebuild-mode gate sits at the call sites, not in the enqueue

A configuration key selects when the topic knowledge base and its graph are rebuilt: **manual** or **auto**. **An absent key means manual, so this is the default on every existing install**, and the predicate deliberately tests for `auto` so no migration was needed.

The gate is applied by each **automatic caller**, not inside the enqueue function — which is why the enqueue's own contract below is unchanged and still describes exactly what happens once a caller decides to proceed. Three callers carry it: the post-commit queue drain (gated together with its own "something was committed this run" condition), the post-merge hook, and the back-fill engine (gated together with "at least one memory was generated" and with not being a dry run).

**The consequence is an inversion of what this topic otherwise describes**: on a default install no git operation — commit, merge, rebase, amend, squash — enqueues an ingest, so the cooldown window, the force bypass and the recovery rule are all reachable only from the manual surface or from an install that opted into `auto`. The manual command-line entry points and the dashboard's and editor's on-demand rebuild are **not** gated: they are the user asking outright.

Recall and commit search are unaffected in either mode, because they read the per-commit memories rather than the topic pages.

### Enqueue contract

The trigger entry point takes a project working directory, a trigger-source tag, and an optional force flag. It returns a boolean: `true` only when an ingest operation has been written to the queue, `false` on every other outcome.

Wrapped in a single top-level try/catch — any thrown error from any step is caught, logged at debug level, and returns `false`.

In execution order:

1. **Cooldown gate.** If the force flag is unset and the cooldown check returns "in cooldown", log a debug message tagged with the trigger source and return `false`. No queue write, no cooldown update.
2. **Build the queue entry.** Compose the operation object: fixed ingest discriminator, the supplied trigger-source tag, and a fresh ISO-8601 created-at timestamp.
3. **Queue write.** Delegate to the unified queue-enqueue routine, which writes one JSON file under the per-project queue directory using a timestamp-plus-sequence filename. The routine returns a boolean.
4. **Cooldown update gate.** If and only if the queue write returned `true`, mark the cooldown record with the current time. Return the queue write's boolean.

The ordering is load-bearing: the cooldown is updated **after** a confirmed queue write, never before. A queue write that fails (returning `false`) or throws leaves the cooldown record untouched, so the next trigger is not suppressed by a window the previous failure would otherwise have opened.

### Force bypass

The force flag skips step 1 above. The remaining steps are identical; in particular, a forced enqueue still updates the cooldown on success, so a forced trigger restarts the window for any subsequent non-forced trigger.

The force path is used by merge-event triggers where suppressing the ingest would leave externally-authored content un-ingested until either the cooldown expired and some later trigger fired or the user ran the manual command. The repo-wide ingest operation is idempotent — a duplicate drain finds nothing pending and no-ops — so the occasional duplicate from a force bypass is benign.

### Concurrency outcome

Two truly-simultaneous callers can both observe "not in cooldown" and both write a queue entry. The duplicate is tolerated because the pipeline's drain is idempotent: the second drain finds the high-water mark already advanced past every source written before it started and produces a no-pending outcome.

### Failure paths that do not burn the cooldown

The cooldown is updated only after a confirmed queue write. The following all leave the cooldown record unchanged so a subsequent trigger can recover:

- The queue write returns `false` (transient I/O error on the temp-write/rename, directory missing and uncreatable, etc).
- The queue write throws (caught at the top-level try/catch).
- The cooldown read itself throws (treated as no cooldown, but no update is attempted on the failure path).

### Trigger-source tag values

Four enumerated values, all carried verbatim into the queued entry and into the eventual telemetry record:

- **post-commit chain trigger** — set by the queue worker after it drains a batch of commit entries that included at least one summary-producing commit.
- **post-merge** — set by the post-merge hook after at least one merge commit is detected in the just-pulled range. Always supplied with the force flag.
- **recall-miss** — reserved for a recall path that detects insufficient indexed content; not currently emitted by any production caller, but the tag is part of the public enum and is treated identically to the others.
- **manual** — set by the command-line ingest entry point on the single-repo path, and additionally emitted once after a successful historical back-fill batch (the back-fill engine enqueues one repo-wide ingest with the force flag set, bypassing the cooldown, when at least one memory was generated — see the back-fill-engine-orchestration spec).

### Command-line entry point — top-level dispatch

The command-line entry takes the parsed flag set. In order:

1. If the working-directory override is set, run the single-repo path with the rebuild flag (which may be off).
2. Otherwise, if the rebuild flag is set without the working-directory override, write a fixed error line to stderr ("`--rebuild` requires `--cwd <dir>` — rebuild targets a single repo") and set the process exit code to 1. Return without invoking either drain path.
3. Otherwise, run the sweep path.

### Single-repo command path

In execution order:

1. **Initialise the project log directory** for the supplied repo path. This is unconditional and runs before any precondition check.
2. **Load configuration.** Includes any stored Anthropic API key, any stored jolli-platform API key, and the configured knowledge-bank folder.
3. **Credential precondition.** If none of: configured Anthropic key, configured jolli-platform key, or the Anthropic-API-key environment variable is set, then:
   - Write a fixed error line to stderr: "Error: No API key configured. Run 'jolli enable' to set up."
   - Append a credential-missing bookkeeping entry tagged `manual` against the supplied repo.
   - Set process exit code to 1.
   - Return.
4. **Resolve storage.** Construct the dual-write storage rooted at the supplied repo path. Capture the prior process-global active-storage value, then install the new one. A `finally` block at the bottom of this command path restores the captured prior value regardless of how the body terminates — including thrown errors — so the override does not leak into a long-lived host.
5. **Build a per-write serialisation guard** rooted at the knowledge-bank-folder vault root. The lock is **not** held across the command body: each persistence step re-acquires it briefly, in wait mode with a fixed default wait, and releases it immediately. A step whose acquisition times out surfaces a typed "busy" signal to that step's caller rather than aborting the command. The long, model-bearing reconcile phase therefore runs **unlocked**, so a concurrent commit-summary worker can take the lock between this command's writes and produce its summary promptly.
6. **Run the body**, in order:
   1. If the rebuild flag is set:
      - Print a console line "Rebuilding knowledge base from scratch...".
      - Under one guarded write: reset the high-water mark to its empty form and reset the routing index to its empty form. Both writes go through the dual-write storage installed at step 4.
      - This reset is a **prerequisite, not a derived view**, so a busy guard here is fatal: write a fixed error to stderr ("Error: another vault writer (a background worker or sync) is busy — try again shortly."), set exit code to 1, and return. (Continuing would leave the index populated and silently degrade the rebuild into a no-op incremental drain.) A non-busy write error propagates.
   2. Otherwise, print a console line "Ingesting pending sources into the knowledge base...".
   3. Invoke the pipeline drain on the repo path with the loaded configuration, the trigger-source tag `manual`, and the per-write guard. The drain returns a result envelope summarising the run.
   4. **Only when the rebuild flag is set**, and wrapped in its own non-fatal envelope: under one guarded write, read the routing index back through the active storage and invoke the orphan-page purge with the set of stable slugs from that index — the purge keeps exactly the indexed slugs and removes any topic page whose slug is not in the set. Any error (including a busy guard) is logged at warn level and skipped. A routine (non-rebuild) compile **must not** purge: because the lock is released between writes, a concurrent ingest can add a topic page that is not yet in this command's index snapshot, and purging "everything not in the index" would delete it. Orphans left behind by a skipped purge, or by topic consolidation during a routine compile, are reclaimed by the next explicit `--rebuild`.
   5. Invoke the visible-wiki render on the repo path through the active storage and the per-write guard, wrapped in its own non-fatal envelope: any error is logged at warn level and skipped.
   6. Build the knowledge graph from the freshly-ingested knowledge base, through the active storage, wrapped in its own non-fatal envelope: any error — including a missing credential — is logged at warn level and skipped. This step runs **unguarded** because it is model-bearing; holding the vault lock across it would re-create the commit-blocking stall the per-write guard exists to remove. The graph is a derived artefact, regenerated on the next compile.
   7. **Best-effort search-index warm.** In an inner try, lazy-import the local search index module and rebuild it on the repo path through the active storage under one guarded write. Any error from the import or the rebuild is logged at warn level and swallowed — search-index warming must never fail the command. (The lazy import contains the dependency: if the search index's underlying engine fails to load, only this warming step is lost, not the entire command path.)
7. **Summarise to the console.** After the body ran:
   - Print a line "Done: <added-note>. Wiki rebuilt. [<OUTCOME-CODE>]" where the outcome code is the structured terminal code from the drain and the added-note branches on the ingested count: when the count is zero, "already up to date -- no new commit summaries to add"; otherwise "added <N> new commit summary/summaries (<M> batch(es))" with the noun pluralised on the count. The user-facing wording says "commit summaries", never the internal word "sources", so a zero count reads as "already up to date" rather than "0 sources".
   - When the drain reported any per-topic failures, print an additional line "<K> topic(s) held: <slug1> (<code1>), <slug2> (<code2>), …".
8. **Restore prior active storage** in the outer `finally`.

Steps 6.4 through 6.7 are all **derived-layer regeneration** over data the drain has already persisted, which is why each carries its own non-fatal envelope: the memories are safe once the drain returns, and only the regenerated views lag until the next compile. Failing the whole command on a derived-layer hiccup is what previously made a successful ingest report as a failure.

### Sweep command path

In execution order:

1. Load configuration.
2. Credential precondition — same logic as the single-repo path. No bookkeeping entry is written on this path; the error message and exit code are emitted but no append occurs. Return.
3. Knowledge-bank-folder precondition: the configured knowledge-bank folder must be set. If not, write a fixed error to stderr ("Error: No Memory Bank folder configured (localFolder). Set one in Settings."), set exit code to 1, and return.
4. Print "Adding pending commit summaries across all Memory Bank repos...".
5. Delegate to the multi-repo sweep entry point with the configured knowledge-bank folder and the loaded configuration. The sweep is its own spec (160) and owns:
   - Repo discovery under the knowledge-bank folder.
   - Per-repo storage construction (folder-only, no orphan working tree).
   - Per-repo drain, per-repo wiki render, per-repo knowledge-graph build, per-repo best-effort search-index warm. The sweep runs **no** orphan-page purge on any repo, for the same reason the routine single-repo compile does not.
   - Per-repo failure isolation: an error in one repo never aborts the rest of the sweep.
   - The same per-write serialisation guard the single-repo path uses, with the same bounded wait.
6. Sweep outcome handling:
   - For each per-repo result, print either a success line "✓ <folder>: <per-repo note>" — where the note is "up to date" when that repo ingested nothing and "<N> new commit summary/summaries" otherwise — or a failure line "✗ <folder>: <error message>".
   - Print a final summary line "Done: <aggregate note>[, <failed> failed]." where the aggregate note branches on the total: when the total is zero, "all <count> repo(s) already up to date -- no new commit summaries to add"; otherwise "added <total> new commit summary/summaries across <count> repo(s)".
   - If the sweep reported one or more failures, set exit code to 1.

### Lock semantics on both paths

Both paths use the same serialisation primitive against the same key (the vault root derived from the knowledge-bank folder), in the same mode: **acquired per write, in wait mode with a fixed default wait, never held across the drain**. Neither path takes a whole-command lock, and neither reports a "skipped because another compile holds the lock" outcome.

Rationale: a compile is long and model-bearing, and holding the vault lock for its duration starved commit-summary workers — they timed out waiting and left their queue entries orphaned. Commit memory is high-priority; a "build wiki" may proceed slowly. Data safety without the long lock comes from the drain's own guarded-write phase (topic pages re-read and compare before writing, so no clobber; the index and the high-water mark are read-modify-written under the same guard, so no lost update), not from lock duration.

Consequences the two paths share:

- Two compiles over the same knowledge-bank folder can now **overlap**. That is safe under the same optimistic-concurrency guards, merely potentially redundant model work.
- A busy guard on an individual write is a typed signal, not a command failure. The **only** place it is fatal is the single-repo `--rebuild` reset, because that reset is a prerequisite rather than a derived view.

### Output-stream policy

Console error lines for preconditions, lock contention, and configuration errors go to stderr. All progress lines, the per-repo result lines, the final summary line, and the lock-busy "another compile is already running" line go to stdout. The exit code carries the success/failure signal independently of which stream emitted the message.

## State Transitions

### Cooldown state machine (per project)

```
  (no record / unparseable timestamp)
              │
              │  successful enqueue (forced or unforced) at time T
              ▼
        [open until T + 5 min]
              │
              ├──── trigger arrives at T' < T + 5 min, force=false ──► suppressed, state unchanged
              │
              ├──── trigger arrives at T' < T + 5 min, force=true   ──► (re-enters this state with T' as new anchor)
              │
              ├──── trigger arrives at T' ≥ T + 5 min                 ──► (re-enters this state with T' as new anchor)
              │
              ├──── trigger throws or queue write returns false        ──► state unchanged (recovery possible on next trigger)
              │
              └──── cooldown record manually corrupted or deleted      ──► back to "no record" (next trigger always passes the gate)
```

### Command-line single-repo path — exit-code state machine

```
  start
   │
   ├── credential missing                    → stderr error + bookkeeping entry + exit 1
   ├── --rebuild reset: guard busy           → stderr error + exit 1
   ├── body runs:
   │     ├── derived-layer step fails/busy    → warn-and-skip; body continues
   │     ├── any other thrown error bubbles   → finally restores active storage; exit code from harness
   │     └── normal completion                → stdout summary lines + exit 0 (drain outcome carried in summary text, not exit code)
   └── (no other exit-1 paths)
```

### Command-line sweep path — exit-code state machine

```
  start
   │
   ├── credential missing            → stderr error + exit 1
   ├── knowledge-bank folder unset   → stderr error + exit 1
   ├── --rebuild without --cwd       → stderr error + exit 1 (caught at top-level dispatch, before sweep)
   ├── sweep ran, all repos ok       → stdout per-repo lines + summary + exit 0
   └── sweep ran, ≥1 repo failed     → stdout per-repo lines (with ✗ entries) + summary + exit 1
```

## Notable Behavior

- **Cooldown is updated only after a confirmed queue write.** A queue write that returns `false` or throws leaves the cooldown unchanged so the next trigger is not suppressed by a window the previous failure would have opened. The trade-off — accepted in the design — is that two truly-simultaneous callers can both pass the gate and both write an entry; the duplicate drain is benign because the pipeline is idempotent.

- **A malformed timestamp on disk never blocks a trigger.** Any record that fails to parse, fails the object-shape guard (e.g. an accidental array), or has a not-a-number millisecond value is treated as "no cooldown".

- **Force bypass still anchors the cooldown.** A forced enqueue updates the cooldown record on success, so a forced trigger restarts the window for subsequent non-forced triggers.

- **The trigger-source enum includes a value (`recall-miss`) that no production caller currently emits.** The value is carried in the type definition and tests reference it; if some future caller emits it, the cooldown and queue contract treat it identically to the other tags.

- **The credential-missing bookkeeping entry is written only on the single-repo command path, not on the sweep path.** On the sweep path the configuration check happens before any per-repo work, so there is no per-repo telemetry entry to attribute the credential failure to. The sweep simply prints the error and exits.

- **The bookkeeping store tolerates corruption.** A corrupt or non-array ring-buffer file is read as empty; the next append writes a single-element array. A valid JSON object (rather than the expected array) is also read as empty.

- **The orphan-page purge runs only on `--rebuild`** — never after a routine single-repo drain, and never anywhere in the sweep. The purge keeps exactly the stable slugs present in the current routing index, so it is only safe where the read and the purge happen under one guarded write against an index this command just reset. On a routine compile the lock is released between writes, so a concurrent ingest can add a topic page that is absent from this command's index snapshot; purging "everything not in the index" would delete it — data loss. The cost of the narrowed condition is that orphans from topic consolidation linger until the next explicit `--rebuild`, which is the accepted trade. (This is a reversal of earlier behavior, where the purge was unconditional after every drain.)

- **Every step after the drain is individually non-fatal.** The purge, the wiki render, the knowledge-graph build, and the search-index warm each carry their own catch: a failure — including a busy serialisation guard — is logged at warn level and skipped, and the command still reports success. They are all derived-layer regeneration over data the drain already persisted, so the memories are safe and only the regenerated views lag. Failing the whole command on one of these is what previously made a successful ingest report as a failure.

- **The knowledge-graph build runs unguarded.** It is model-bearing, so holding the vault lock across it would re-create the commit-blocking stall the per-write guard removes. The graph is a derived artefact, rebuilt on the next compile.

- **The visible-wiki render runs unconditionally after the single-repo drain**, including when the drain ingested zero sources. The command-line path always re-renders (subject to its non-fatal envelope); this differs from the background-worker path, which renders only when sources landed or the wiki is missing on disk (see queue-worker spec 34).

- **The search-index warming is best-effort and lazy-imported.** A failure (missing optional engine, incompatible runtime, file I/O error) is logged at warn level and swallowed. The lazy import contains the dependency footprint: a load failure inside the inner try does not propagate to the outer command path.

- **The single-repo command path captures and restores the process-global active storage in a `finally`** so the override never leaks into a long-lived host (e.g. an editor extension that exposes this entry point in-process). For the one-shot command-line use the restore is benign, but the entry point is intentionally safe for hosted use.

- **Neither command path can be declined by the lock any more.** There is no whole-command lock and therefore no "another compile is already running — skipped" outcome on either path: two compiles over the same knowledge-bank folder may overlap, which is safe (the drain's read-modify-write guards preserve correctness) and at worst redundant. The only lock-derived non-zero exit left is a busy guard on the `--rebuild` reset.

- **`--rebuild` is only valid with `--cwd`.** Supplying it without `--cwd` is treated as user error: a stderr message and exit code 1. The rebuild semantics are inherently single-repo (reset that repo's high-water mark and routing index), so the dispatcher refuses to interpret it for a sweep.

## Shared Behavior

- The pipeline mechanics consumed by both command-line paths and the queue-worker dispatch path are owned by spec 152 (topic ingest pipeline). This spec only describes what crosses the boundary into the pipeline (a working directory, a configuration, and a trigger-source tag) and what comes back (a result envelope with batches, ingested count, outcome code, and per-topic failures).

- The multi-repo sweep — repo discovery, per-repo storage construction, per-repo failure isolation, per-repo wiki render, per-repo knowledge-graph build, and its use of the same per-write serialisation guard — is owned by spec 160.

- The queue worker that drains an ingest operation (and chain-triggers a follow-up ingest after processing commit entries) is owned by spec 34. The trigger contract here is the producer side of that queue. Note that a queued ingest operation is drained not in the summary drain but in a **separate ingest phase** that runs after the summary drain, under its own per-worktree ingest lock (specs 34, 259) — not the summary-drain lock. This spec's boundary deferring the drain and its serialisation lock to specs 34 / 171 / 259 stays correct.

- The credential resolution chain (Anthropic API key, jolli-platform key, environment variable) and its precedence are owned by spec 10. This spec only treats their presence/absence as a single boolean precondition and the corresponding fixed error message.

- The atomic temp-file-plus-rename write used for the cooldown record and the ring-buffer file is the same primitive used throughout the local jollimemory directory (cursors, sessions, queue entries). Behavior under crash mid-write is: the previous file is observable until the rename completes; the partial temp file is not.

- The structured outcome-code enum referenced in the single-repo summary line is shared with the pipeline's per-run telemetry and is part of the ingest-pipeline contract. The codes are append-only — never renumbered — so they can be matched textually by downstream tooling.
