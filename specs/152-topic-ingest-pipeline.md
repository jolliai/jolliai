# 152. Topic Ingest Pipeline

## Topic Statement

Fold every unprocessed development source into a stable, per-topic page collection by classifying each batch of sources to topics with one model call, then reconciling each affected page's current body with the new source bodies through a second model call per topic.

## Scope

**In scope:**
- The trigger surface — what events enqueue a repo-wide ingest, the debounce window, the force-bypass rule, and the recovery semantics when an enqueue fails.
- The on-disk persistence the pipeline reads and writes: the per-topic page collection, the routing index, the high-water mark (already-processed source identifiers), the per-cwd cooldown record, and the bounded telemetry ring.
- The structured outcome code set and how each one is reached.
- The batched drain loop, the adaptive iteration guard, and the two-phase per-batch pipeline (route call, then concurrent reconcile calls with serial apply).
- Per-topic failure isolation, per-source hold-for-retry semantics, the un-filed fast path, and the "vanished source body" tolerance.
- The single-repo path and the all-repos sweep, including the per-write acquisition of the lock that serialises them against background ingest, sync, and other sweeps, and the single step where a busy acquisition is fatal.
- The rebuild path that resets the high-water mark and routing index, then replays every source.
- The rule that the pipeline itself **never** purges orphan topic pages, and which single caller does (the single-repo compile's rebuild path only).
- The render-after-drain rule that produces a visible wiki layer when the active storage supports it, including the deleted-wiki recovery condition.
- Cross-storage threading: ensuring routing, reconciliation, and page reads observe a single snapshot (the same view enumerated by the source timeline).

**Out of scope (boundaries):**
- How the per-source bodies are produced upstream (commit summaries are spec 12; squash consolidation is spec 13; amend/rebase migration is specs 39-41).
- The source timeline that enumerates pending sources and assigns the deterministic old-to-new order across the four source streams (separate concern, see source-timeline spec when produced).
- The credential resolution and underlying model call protocol (LLM client / provider routing — spec 9 and related).
- The visible-wiki renderer's manifest bookkeeping, link resolution, and disk layout — only the contract the pipeline calls into is in scope.
- The orphan-branch vs folder-layout storage providers (the pipeline routes all reads through one injected storage and writes through the active storage; the provider implementations are their own specs).
- The search index warming that runs after the drain on the compile entry points (search specs 137-139).
- The queue worker that dequeues an ingest entry and dispatches to this pipeline (spec 34); the pipeline is the dispatch target, not the dispatcher.
- The repo-discovery layer used by the sweep (separate spec for memory-bank repo discovery).
- The model prompt templates themselves (route, reconcile) — only the request shape, the response contract, and the parser are in scope.

## Data Contracts

### Source reference (input)

Each source presented to the pipeline carries:
- **Type** — one of: summary, plan, note, user-authored knowledge file.
- **Identifier** — a string that is stable and unique within its type (commit hash, plan slug, note id, or `path@content-fingerprint` for user files).
- **Timestamp** — an ISO-8601 instant used for the deterministic old-to-new ordering.
- **Branch** — optional originating branch name for branch-scoped sources (summary, plan, note). User-authored knowledge files omit it because they are repo-wide or global. Refs deserialized from older persisted pages may also lack it.

### Source body and headline

For each source reference the pipeline can ask the source loader for:
- A single-line **headline** suitable for inclusion in the route prompt (newlines collapsed to spaces).
- A full **body** for inclusion in the reconcile prompt, or null when the source has vanished or no longer matches its fingerprint.

### Routing index (persisted)

One file holds a versioned record listing every known topic. Each entry contains:
- A **stable slug** (kebab-case, lowercase alphanumerics and dashes, 3-40 characters).
- A human-readable **title**.
- A short **summary** sentence used as the topic's index bullet.
- A list of **related branches** distinct contributing real branch names in first-seen order.
- The full list of **source references** that have been folded into the topic.
- A **last-updated** ISO-8601 timestamp.

The file is "version 1" and tolerates missing/corrupt content by being treated as empty.

### Topic page (persisted, one per topic)

Each topic has its own file keyed by stable slug containing:
- Schema version (1).
- Stable slug.
- Title.
- Full content body (the reconciled prose).
- Related branches (same shape as in the index).
- Source references that have been folded into this page (same shape as input source references, accumulated across batches).
- Last-updated ISO-8601 timestamp.

Slugs are validated at the persistence boundary: non-empty, must not contain `/`, must not contain `..`. Unsafe slugs are refused (read returns null with a warning; write throws).

### Processed-source set (persisted high-water mark)

One file holds a versioned record with four buckets (one per source type), each a list of identifiers already folded into the knowledge base. The shape is deliberately a set of identifiers, not a single timestamp watermark — this guarantees an out-of-order source surfacing late is not silently skipped. The file is "version 1" and tolerates missing/corrupt content by being treated as empty (all four buckets empty). The structure round-trips even if older persisted files lack some bucket keys (missing buckets default to empty lists).

### Cooldown record (per cwd, per-project)

A small file under the per-project memory dir, containing one optional ISO-8601 instant of the last successfully-enqueued ingest. Missing, unparseable, or non-object content is treated as "no cooldown".

### Telemetry ring (per cwd, per-project)

A bounded JSON array of at most 20 most recent ingest run records. Each record carries: start instant, duration in milliseconds, what triggered the run, the structured outcome code, batches processed, total sources folded, count of topics touched, route-call count, reconcile-call count, and a list of per-topic failures (slug plus structured code). Missing or corrupt file is treated as empty. Each successful or unsuccessful drain appends exactly one record; a no-op skip when no credentials are present appends a one-off zero-counts record carrying the credential-missing outcome.

### Outcome code set

The pipeline emits structured outcome codes (stable, append-only — never renumber):
- **OK** — drain ran one or more batches and produced no batch-terminal failure.
- **NO_PENDING** — the first batch saw zero pending sources; nothing further ran.
- **CREDENTIAL_MISSING** — the credential pre-check failed and the drain was skipped.
- **ROUTE_FAILED** — a batch's route response was truncated, not parseable JSON, or referenced an out-of-range source ordinal.
- **RECONCILE_TRUNCATED** — a per-topic reconcile call stopped at the maximum-tokens limit.
- **RECONCILE_PARSE_FAILED** — a per-topic reconcile call returned but its content was not parseable into a topic page.
- **RECONCILE_CALL_FAILED** — a per-topic reconcile call threw (network, abort, transport). Kept distinct from a parse failure so telemetry does not mislabel a transient transport failure as a deterministic content problem.
- **NO_SOURCE_CONTENT** — every source assigned to a topic had a null body; the reconcile call was never issued.
- **PAGE_WRITE_CONFLICT** — a per-topic guarded write was held (not written): either the vault-write lock could not be acquired within budget, or the page changed under us during the lock-free reconcile phase (optimistic-concurrency divergence). Benign — the source is held and retried on the next drain. (See "Guarded write phase" below.)
- **PAGE_WRITE_ERROR** — a per-topic guarded write threw for a reason that is **not** lock contention (I/O, serialization, plumbing fault). The source is held so the batch can continue, but it is surfaced distinctly from the benign conflict so it is not silently retried forever.
- **ITERATION_GUARD** — the drain loop hit the adaptive maximum-iterations safety cap (it was not making progress).

### Routing plan (in-memory, per batch)

The route model returns a JSON object describing two arrays:
- **updates** — assignments to topics already in the routing index. Each carries a stable slug and a list of source ordinals (indexes into the batch shown to the model).
- **newTopics** — assignments to topics not yet in the routing index. Each carries a stable slug, a title, and a list of source ordinals.

The parser optionally strips a `` ```json ... ``` `` fence the model may wrap the object in. A slug appearing in both arrays is union-merged with the new-topic flag preserved (so reconcile gets the correct title and "no existing page" hint).

### Reconciled page (in-memory, per topic)

The reconcile model returns a delimited document containing one block. The parser extracts: title, stable slug, a short one-sentence summary, the content body, optional key decisions list, optional related-branches list, and optional source-commits list. The caller-supplied authoritative slug and title win over the model's echoes (the model's branch list is advisory only — see below).

## Behavior

### Trigger surface

The pipeline is invoked through three trigger pathways, all sharing the same drain entry point:

1. **Post-merge enqueue.** When the post-merge hook detects a merge commit in the just-pulled range (either by HEAD reflog inspection or, when the reflog is unavailable, by checking that HEAD has two or more parents), it enqueues one repo-wide ingest operation onto the project's git operation queue. The enqueue **forces past the cooldown** because a merge brings in genuinely new content authored elsewhere. If no credential is configured, the merge hook silently does nothing.
2. **Post-commit enqueue.** When the queue worker finishes draining commit-typed entries, it enqueues a single ingest operation tagged "post-commit", subject to the cooldown debounce. This collapses commit bursts to one drain.
3. **Manual / on-demand.** The compile entry point can target a single repo (caller specifies the cwd) or sweep every discovered repo under the configured memory bank folder.

### Cooldown debounce

The enqueue helper checks a 5-minute per-cwd cooldown. If the last enqueue was within the window and `force` is not set, the new enqueue is skipped and the call returns `false`. Otherwise the operation is enqueued and, **only on a successful enqueue**, the cooldown is marked. A failed enqueue (the underlying queue returned `false`, or threw) leaves the cooldown untouched so the next trigger can recover. A non-finite or unparseable timestamp in the cooldown file is treated as "no cooldown". Two truly-simultaneous callers can both pass the cooldown check and enqueue; this is accepted because a repo-wide ingest is idempotent (the second drain finds nothing pending and no-ops).

### Drain entry — pre-check and outer loop

When invoked (whether from queue dispatch or from a compile entry point) the drain:
1. Reads credentials. If none are present (provider key, vendor proxy key, and provider env var all absent) the drain logs and appends a single credential-missing telemetry record with zero counts and returns immediately.
2. Starts a high-resolution timer.
3. Initialises an adaptive iteration cap as "infinity" until the first batch reports pending count.
4. Runs `ingest one batch` in a loop until: a batch reports `done` (pending count fit in one batch), or a batch returns a batch-terminal error code, or the adaptive cap is hit.
5. Aggregates counts (batches, sources folded, route calls, reconcile calls, touched slugs, per-topic failures) across all batches.
6. On the first batch result, computes the iteration cap as `ceil(first-batch pending count / batch size) + 2`. If the first batch reported zero pending sources, the outcome is set to NO_PENDING (and the loop exits naturally because the batch is also marked done).
7. Appends one telemetry record with the aggregated counts, the trigger tag (defaulting to "manual" when not provided), and the computed outcome code.
8. Returns the aggregated counts and outcome.

The outcome code resolution order:
- If a batch returned an `errorCode` (e.g. ROUTE_FAILED), the loop breaks and that code is the run outcome.
- Else if the adaptive cap was hit, outcome is ITERATION_GUARD.
- Else if the first batch had zero pending, outcome is NO_PENDING.
- Otherwise outcome is OK.

### Ingest one batch — read side

Each batch:
1. Resolves the **read storage** snapshot. If the caller supplied one (the all-repos sweep does), it is used. Otherwise one is created from the cwd. **Every read in the batch goes through this snapshot** — the processed set, the routing index, pending source enumeration, per-source headlines, per-source bodies, and the current topic page during reconcile — so route and reconcile cannot see a split snapshot. Writes deliberately do not go through this snapshot; writes use the active storage so they propagate to both layers of any dual-write provider.
2. Loads the processed-source set.
3. Asks the source timeline for the not-yet-processed sources in deterministic old-to-new order.
4. Returns the empty zero-counts "done" result if nothing is pending.
5. Slices the pending list to the configured batch size (default 50) — this is the "batch" the rest of the steps operate on.

### Ingest one batch — route phase

6. Loads the routing index.
7. Loads a one-line headline for each source in the batch.
8. Formats two prompt inputs:
   - **Topic index** — one bullet per existing topic in the form `- <slug> -- <title>: <summary>`, or the literal `(none yet)` if the index is empty.
   - **Sources** — the batch headlines, each prefixed with its ordinal as `[i] <headline>` on its own line.
9. Issues one model call tagged "route" with `forceStreaming=true` (so the call uses the streaming transport and is bounded only by idle and wall-clock watchdogs, not a direct-call deadline) and an output cap of 16 384 tokens.
10. Parses the response:
    - If the response stop reason is `max_tokens`, parse-error "output truncated at max_tokens".
    - Else strip an optional `` ```json … ``` `` fence and `JSON.parse`. Failure → parse-error "not valid JSON".
    - Walk `updates` then `newTopics`. For each entry: ignore if the slug is missing or empty; ignore numeric out-of-range indexes by setting a malformed flag, log a warning, and continue. After both lists, if the malformed flag is set, return a parse-error "out-of-range source index".
    - Otherwise build the assignment map (slug → `{title?, isNew, refs[]}`), union-merging when a slug appears under both lists and keeping the new-topic flag plus title from the new-topic side. The per-batch deduplication of refs within an assignment uses identity reference equality (the same source ref object cannot appear twice in one assignment).
11. If route parsing produced an error, the batch returns immediately with: zero sources folded, zero touched slugs, `done=false`, the original pending count, zero reconcile calls, empty per-topic failure list, and `errorCode = ROUTE_FAILED`. No processed-set update, no page write, no index write.

### Ingest one batch — reconcile phase

12. For each assignment, in parallel up to 4 concurrent tasks:
    - If the assignment is **not** new, load the current topic page from the snapshot; if it is new, the current page is null.
    - Pick the title: prefer the existing page's title, then the assignment's title (only present for new topics), else fall back to the slug.
    - Sort the assignment's refs by the deterministic old-to-new order — reconcile receives source bodies oldest first so its "recency wins" semantics fold the freshest at the end of the document.
    - For each sorted ref, load the source body. Each null body (vanished source: deleted plan/note, summary that no longer resolves, user file whose fingerprint moved) is **skipped, not failed** — the assignment continues with the surviving sources.
    - If **every** source body was null, the task short-circuits to a held failure with code NO_SOURCE_CONTENT (no model call is issued).
    - Otherwise issue one model call tagged "reconcile" with output cap 64 000 tokens. Parameters: `topicTitle`, `currentPage` (or the literal `(new topic -- no existing page)` for a new topic), and `sources` formed by joining the surviving bodies with a `### (<type>, <timestamp>)` header per body, separated by blank lines.
    - If the response stop reason is `max_tokens`, the task fails with RECONCILE_TRUNCATED (the existing page is kept untouched, the assignment's sources are held).
    - Parse the response. If no `===TOPIC===` block is parseable into a page, the task fails with RECONCILE_PARSE_FAILED (the parser does have one recovery path: when the model omits the title marker entirely, it recovers the body from the first raw block using the authoritative title — only an absent content body is a real parse failure). The **diagnostic** for this failure additionally names the configured generation provider and the configured agent-tool identity, and quotes the reply's leading text bounded to the **first 200 characters** (quoted, so an empty or whitespace-only reply is distinguishable from a missing one). The outcome and its structured code are unchanged by that — the existing page is still kept and the assignment's sources are still held.
    - On parse success the task builds two artefacts:
      - The new topic page: schema 1, the authoritative stable slug, the parsed title, the parsed content, the related branches **derived from the source refs**, the merged source refs (old page's refs first, then the surviving folded refs that are not already present by `type:id`), and `lastUpdatedAt` set to the batch's "now" instant.
      - The new index entry: same shape minus content.
    - **Related branches are authoritative from the contributing sources' branches, not from the model's `RELATEDBRANCHES` echo.** The branches list is the distinct set of real branch names across the merged refs, in first-seen order, filtering out empty branches (user files and legacy refs lacking the field) and the literal sentinels `(unknown)` and `unknown`.
    - If the reconcile call itself **throws** (network, abort, transport), the task is degraded to a held failure with code RECONCILE_CALL_FAILED (kept distinct from RECONCILE_PARSE_FAILED so telemetry preserves the failure class).

### Ingest one batch — serial apply phase

The apply phase runs each persistence through an injected **write guard**. See "Guarded write phase (the write-guard contract)" below for what the guard does; the steps here describe the apply logic that sits on top of it.

13. Walk the per-topic reconcile outcomes in order. For each outcome:
    - Count it as one issued reconcile call **unless** the failure code is NO_SOURCE_CONTENT (which never reached the model).
    - On reconcile success: attempt the guarded page-plus-index write. If the guard **holds** it (lock busy in budget → PAGE_WRITE_CONFLICT; live page diverged from the snapshot reconcile used → PAGE_WRITE_CONFLICT; a non-contention fault → PAGE_WRITE_ERROR), treat it as a failure for this assignment. Otherwise record the touched slug.
    - On failure (reconcile failure **or** a held guarded write): mark every ref this assignment was supposed to fold as "failed" and record the per-topic failure (`{slug, code}`).
14. Compute the routed set: every ref that appeared in any assignment. Compute the succeeded set: every batch ref that is not in the failed set. A ref **not routed anywhere** (the route model assigned it to no topic) is still considered succeeded — it is logged as "un-filed" and added to the processed set so it does not re-surface forever. A ref routed to **any** failed-or-held topic is held back, even if it was also routed successfully to another topic. The succeeded set is computed **after** the guarded page writes so page-write holds are reflected in it.
15. If the succeeded list is non-empty, write the updated processed-source set through the write guard (its own guarded read-modify-write, after every page+index write).
16. Return the batch result: count of newly-marked sources, the touched slugs list, `done = (pending count <= batch size)`, the original pending count, the reconcile-call count, and the per-topic failures list.

### Guarded write phase (the write-guard contract)

Every production caller injects a **write guard** — a wrapper the pipeline runs each persistence inside. In production the guard acquires the per-vault write lock (bounded-wait, worker budget) and nests the repo-level orphan-write lock inside it (the vault→orphan ordering owned by spec 171), runs the write, then releases both; a lock-busy timeout surfaces as a typed "vault busy" sentinel. In unit tests the guard defaults to identity (run the write directly). The pipeline's contract on top of that guard:

- **Page and index are written in one guarded section, atomically.** A topic page never lands without its index entry. Splitting them into two independent guarded sections could persist the page and then fail to re-acquire the lock for the index write, orphaning the page (on disk, absent from the index) — the next drain would re-route it as a brand-new topic whose guarded re-read then finds the orphan page and holds the source forever (recoverable only by `--rebuild`).
- **Optimistic concurrency inside the guard.** Between the lock-free reconcile read and this guarded write, a sync pull or a concurrent drain may have rewritten the page. Inside the lock the guard re-reads the live page and compares it to the `before` snapshot reconcile used; on divergence the reconciled body is stale, so the source is **held** (the write is skipped) rather than clobbering the newer content. This is the same PAGE_WRITE_CONFLICT outcome as a lock-busy timeout.
- **Index write merges onto a fresh read.** The index is re-read fresh inside the same guarded section and the entry upserted onto that fresh copy (replace in place by slug if present, else append), so a concurrent index change is merged, not clobbered. No index write happens when no topic changed.
- **A guard throw is a hold, not a batch abort.** A lock-busy sentinel from the guard is caught, the source is held (PAGE_WRITE_CONFLICT), and the batch continues with the remaining outcomes. A non-contention fault is also held but recorded as PAGE_WRITE_ERROR so it is not masked as benign contention.
- **Processed-set is written last, in its own guarded RMW.** After every page+index write, the processed-source set is updated through the guard on a fresh read. A guard failure here is hold-and-continue, not a batch abort: because each page already persisted atomically with its index entry, the held sources stay pending and self-heal on the next drain (the retry takes the update path, the unchanged re-read passes, and the write lands).

Because the guard is acquired and released **per write**, the long lock-free reconcile model calls between writes hold no vault lock — which is what lets a minutes-long ingest run without blocking commit-summary generation on the same vault.

### Adaptive iteration guard

After the first batch, the maximum number of drain iterations is fixed at `ceil(first-batch pending / batch size) + 2`. This catches the pathological case where every batch fails reconcile (so nothing is marked processed, pending count never shrinks, and `done` is always false). When the guard fires, the run outcome is ITERATION_GUARD and the telemetry record reflects the partial counts.

### Multi-repo sweep

The sweep entry point (the bare compile command and the "build wiki" surface in the IDE):
1. Derives the memory bank root from the configured local folder.
2. Builds a **per-write** guard over the shared "vault write" lock: each persistence step acquires the lock in bounded-wait mode, writes, and releases immediately. There is **no** sweep-spanning acquisition, and therefore no skipped-sweep outcome — the sweep body always runs, and two sweeps over the same memory bank root may overlap. The lock is process-aware (reclaims a crashed holder) and heartbeated. The same lock serialises the worker drain and any sync activity; correctness across the released intervals comes from the guarded-write phase described above (pages re-read and compare before writing; index and high-water mark read-modify-written under one guard), not from lock duration.
3. Discovers compile targets: every direct child folder of the memory bank root that has a memory-bank index file and is not excluded by name (the configured exclusion list supports `*` glob).
4. Captures the process-global "active storage" override and restores it in a `finally`, so the per-repo storage swap cannot leak past the sweep into a long-lived host process where it would silently point later reads/writes at the last-compiled repo.
5. For each target: sets the process-global storage to a folder-storage for that repo, drains the ingest with `triggeredBy = "manual"` and that repo's storage as the read snapshot, renders the visible wiki layer (when supported), builds the knowledge graph, and best-effort warms the search index. **No orphan-page purge runs on any swept target.** A per-repo failure is caught, recorded, and the sweep continues — failures never propagate to the other repos.

The sweep's own contract (its aggregate result shape, per-target error envelope, and reporting surfaces) is owned by the multi-repo compile sweep spec.

### Single-repo compile

The compile entry point with an explicit cwd:
1. Pre-checks credentials. If none are configured, prints an error, appends a credential-missing telemetry record, and exits with a non-zero exit code without acquiring the lock.
2. Creates the active storage for the cwd and overrides the process-global with it (captured for restoration in `finally`).
3. Builds the same **per-write** bounded-wait guard the sweep uses; no lock is held across the command body. A busy acquisition is fatal at exactly one step — the rebuild reset in step 4 — where the command prints "another vault writer (a background worker or sync) is busy — try again shortly" and exits with a non-zero exit code. Everywhere else a busy guard is non-fatal.
4. If the `--rebuild` flag was passed, resets the high-water mark and routing index in place (under one guarded write). The rebuild does **not** delete topic page files at this step. With an empty index, the route model treats every topic as new, and reconcile receives a null current page (clean rebuild). Without `--rebuild`, proceeds straight to drain.
5. Runs the drain with `triggeredBy = "manual"`.
6. **Only on the `--rebuild` path:** reads the final routing index and purges any orphan topic page files — the single place in the product where the purge runs. Non-fatal: a failure or busy guard is logged and skipped. A routine (non-rebuild) compile does not purge.
7. Renders the visible wiki layer (when supported). Non-fatal.
8. Builds the knowledge graph. Non-fatal, and unguarded (model-bearing).
9. Best-effort warms the search index (a failure here is logged and never fails the compile).
10. Prints a one-line summary including the structured outcome code, batches, sources folded, and any held topics.

The `--rebuild` flag is rejected when no cwd is provided (rebuild targets a single repo).

### Orphan pages (the pipeline never purges)

**No drain purges orphan topic pages.** The pipeline has no purge step: not after a batch, not at the end of a drain, and not on any of its three dispatch paths (queue worker, single-repo compile, sweep). An orphan — a topic page file on disk whose slug is absent from the routing index, produced by a rebuild that replayed into fewer topics or by a slug change during reconcile — simply lingers in the hidden layer.

The **only** caller that converges page files to the routing index is the single-repo compile's `--rebuild` path, which purges once after its drain; that call, its non-fatal envelope, and the safety reason it is restricted to the rebuild path are specified by the ingest trigger and cooldown spec. The purge mechanics themselves (the slug diff, the reserved names excluded from the scan, and the single delete batch) belong to the topic index and page storage spec.

The restriction is a data-safety requirement, not an omission: purging "every page not in the routing index" is only safe while the writer holds the vault lock continuously across the index read and the deletes. Because every drain path now takes the lock **per write** and releases it in between, a concurrent ingest can add a page that is absent from the purging caller's index snapshot — and an unconditional purge would delete it. An orphan left on disk is inert (see the render rule below); a deleted live page is data loss.

### Wiki re-render condition

After the drain, the visible wiki is re-rendered when the active storage advertises a render hook. The re-render is conditional in the queue-dispatch path: it runs when at least one source was folded **or** when the wiki layer is missing from disk (the user deleted it). Without the missing-wiki recovery, a user who deleted `_wiki/` would be stuck waiting for the manual compile because every subsequent drain sees zero pending and skips the render. In the compile entry points the re-render is unconditional (the user explicitly asked to compile).

The renderer reads pages **from the routing index, not by directory scan** — so an orphaned topic page (which, outside the rebuild path, is never purged) cannot leak into the visible wiki layer.

### Threading the read snapshot

The same read snapshot is threaded into:
- The pending-source enumerator (so the deterministic source ordering matches what the route prompt sees).
- The headline loader and the body loader.
- The processed-set read, the routing-index read, and the per-topic page read inside reconcile.

Writes deliberately bypass the read snapshot and use the active storage so they fan out to both layers of a dual-write provider. This is intentional: route and reconcile must see exactly the same on-disk snapshot, but persistence must always reach both layers.

## State Transitions

### Per source

A source moves through the state machine:

```
PENDING ─(routed to ≥1 topic, all succeeded)──> PROCESSED (in high-water mark)
PENDING ─(routed to no topic)─────────────────> PROCESSED (un-filed, logged)
PENDING ─(routed to ≥1 failed topic)──────────> HELD (still PENDING next batch)
PENDING ─(body load returns null)─────────────> SKIPPED for this assignment;
                                                source remains PENDING if every
                                                target page failed, becomes
                                                PROCESSED if at least one target
                                                page succeeded without it.
```

A user file whose fingerprint changes between scans is treated as a new pending source under its new fingerprint (the old `path@fingerprint` is still marked PROCESSED but is gone from the disk scan, and the new `path@fingerprint` surfaces fresh).

### Per topic

```
ABSENT ─(route assigns sources, reconcile succeeds)──> PRESENT
PRESENT ─(route assigns more sources, reconcile succeeds)──> PRESENT (refs accumulated, body replaced)
PRESENT ─(reconcile fails: truncated / parse / call / no-content)──> PRESENT (old body preserved, sources held)
PRESENT ─(guarded write held: lock busy / page diverged / write fault)──> PRESENT (old body preserved, sources held)
PRESENT ─(rebuild)──> ABSENT in index; PRESENT on disk (orphan); the rebuild path's
                       post-drain purge converges it to ABSENT.
PRESENT ─(slug change)──> ABSENT under old slug, PRESENT under new slug; the old file
                       stays on disk as an orphan until the next rebuild purge.
```

Topic content is replaced on every successful reconcile (the model receives the existing body plus the new source bodies and emits the new full body). Topic source-ref accumulation is additive: previously-folded refs are preserved and the new folded refs are appended in order, deduped by `type:id`.

### Per drain run

```
INITIAL ─(credentials missing)──> CREDENTIAL_MISSING telemetry; no batches run
INITIAL ─(first batch pending = 0)──> NO_PENDING; no further batches
INITIAL ─(batch errorCode)──> outer loop breaks; outcome = that code
INITIAL ─(batch.done)──> outer loop exits naturally; outcome = OK
INITIAL ─(iteration cap reached)──> ITERATION_GUARD
ANY ──> telemetry record appended at the end of the run.
```

### Cooldown

```
NEVER_TRIGGERED ─(enqueue success)──> WITHIN_COOLDOWN
WITHIN_COOLDOWN ─(t > last + 5min)──> READY
WITHIN_COOLDOWN ─(enqueue success)──> WITHIN_COOLDOWN (reset)
WITHIN_COOLDOWN ─(enqueue with force)──> WITHIN_COOLDOWN (reset)
ANY ─(enqueue failure / throw)──> no transition (window left untouched)
```

## Notable Behavior

- **Three trigger paths, one drain.** Post-merge, post-commit, and manual compile all converge on the same single drain function. There is no per-trigger logic in the drain itself — only the telemetry record is tagged.
- **Per-cwd 5-minute cooldown, not per-branch.** Bursts of commits/merges on the same project collapse to one drain.
- **Force-bypass on merge.** Merges always enqueue even within the cooldown window, because the merge content was authored elsewhere and would otherwise stay un-ingested until the window expires.
- **A non-burning cooldown.** Enqueue failure leaves the cooldown untouched so the next trigger can recover. Two truly-simultaneous callers can both enqueue (idempotent drain).
- **Idempotent drain.** A drain run with no new pending sources is a near-no-op that still writes one telemetry record. The wiki re-render is conditional (zero-source drains only re-render when the wiki layer is missing).
- **High-water mark by identifier set, not timestamp.** Sources that surface out of chronological order (e.g. an amend rewriting an older commit's metadata; a sync pulling a historical plan) are never silently skipped because of a timestamp-only watermark.
- **Per-source held-vs-processed depends on assignment success across all targets.** A source assigned to both topic A and topic B is held when either reconcile fails. Without this, a one-time held topic would lose its share of the source forever when the other topic succeeded and the source was marked processed.
- **Un-filed sources are processed.** A source the route model assigned to no topic is logged and added to the processed set so it does not re-surface every drain.
- **Vanished bodies skip silently.** A null body is dropped from the reconcile inputs, not failed. Only when **all** bodies for a topic are null does the topic short-circuit to NO_SOURCE_CONTENT (and even then the existing topic page is preserved).
- **Fail-loud route parsing.** Out-of-range source ordinals fail the whole route call (not silently dropped) so a mis-counted source is not consumed as un-filed and lost permanently.
- **The model's related-branches list is advisory.** The pipeline derives related branches from the contributing sources' real branches and filters out empty values and the literal sentinels `(unknown)` / `unknown`.
- **The model's slug echo is advisory.** The authoritative slug comes from the route assignment. A mismatched echo is warned and ignored.
- **A title-less reconcile block is salvaged.** The parser drops blocks without a title, but the wrapper falls back to extracting the body from the raw first block using the authoritative title — only a missing body is a real parse failure. This avoids re-burning an LLM call every drain on a benign formatting glitch.
- **A reconcile parse failure records who generated the reply and what it actually said.** The diagnostic carries the configured provider, the configured agent-tool identity, and the reply's first 200 characters alongside the topic slug; the outcome code and the hold-the-sources behaviour are untouched. The reason is specific to the agentic providers: a locally-driven agent CLI can "satisfy" a structured-output prompt by using its own tools to write the page to a file and then replying with a one-line receipt. On the wire that is a short, well-formed, non-erroring reply containing no topic block — indistinguishable from a truncation or an ordinary model flub unless the reply text itself is recorded. Without the provider and tool identity in the same line, the failure is also not attributable to the provider that produced it. (Surprising; diagnosis-only, and the bound exists so a large reply cannot flood the log.)
- **Adaptive iteration guard, not a fixed loop cap.** The cap is computed from the first batch's pending count, so a legitimate large backlog drains fully but a non-converging drain stops after at most `ceil(N/batch) + 2` batches.
- **Parallel reconcile, serial writes.** Up to 4 reconcile model calls run in parallel; the apply phase is serial so writes to the topic index and to topic pages cannot race. A serial-phase throw was not observed in the model; the implementation treats reconcile-call throws as held failures (RECONCILE_CALL_FAILED) and continues with the remaining outcomes.
- **`--rebuild` does not delete page files itself.** It resets the high-water mark and the routing index; the purge that follows the same invocation's drain removes the old files. So the actual page files vanish only after that drain completes — a rebuild followed by a credential-missing drain leaves old page files on disk, as does a rebuild whose purge was skipped by its non-fatal envelope.
- **No drain converges page files to the index.** Only the rebuild path purges, so a slug change during an ordinary drain leaves the old page file on disk indefinitely — until someone runs a rebuild. This is the accepted cost of releasing the vault lock between writes: an unconditional purge could delete a page a concurrent ingest had just added. (Surprising; a deliberate reversal of earlier unconditional-purge behavior.)
- **Routing index, not directory scan, drives the wiki layer.** Orphaned topic page files cannot leak into the visible wiki — only into untidy disk state. This is what makes a lingering orphan inert, and therefore what makes the narrowed purge safe to live with.
- **Wiki render is conditional on the storage provider.** Storage providers that do not advertise a render hook leave no visible wiki layer (the canonical topic pages remain authoritative). The dispatch path checks for the hook and silently skips rendering when absent.
- **Topic pages always go through the active storage on write.** This dual-write fan-out is deliberately not gated on the read snapshot, so even when reads target one layer (the folder view), writes still update both layers.
- **Topic page slug guard.** The page persistence boundary rejects slugs that are empty, contain `/`, or contain `..`. A reconcile that somehow produced an unsafe slug throws on write (the only place an LLM-supplied slug would reach disk). Read of an unsafe slug returns null with a warning.
- **Slug normalisation tier on input.** The compile parser normalises raw model slugs (lowercase; replace runs of non-`[a-z0-9-]` with `-`; collapse `--+` to `-`; trim leading/trailing `-`; truncate to 40 chars). When normalisation empties the slug it falls back to slugifying the topic title; when slugification also empties, the slug is `untitled-topic`. Duplicate slugs within one batch keep the first and warn on the rest.
- **Telemetry is a 20-record ring.** Older runs are dropped on append.
- **Process-global storage override is captured and restored.** The single-repo compile and the all-repos sweep both swap a process-global active storage; both restore the prior value in a `finally` so a long-lived host process (IDE extension) never has the override leak past the operation.
- **No retry within a run.** A held source surfaces again in the next drain (the next post-commit, the next merge, or the next manual compile). Within a run, a held topic is held for the rest of that drain.
- **The reconcile prompt receives the existing page body verbatim, not a structured diff.** The model is asked to merge a free-text current body with new free-text source bodies. The pipeline does not compute or apply diffs — every successful reconcile replaces the page body in full.
- **The reconcile prompt receives sources in oldest-to-newest order.** This is the documented contract that drives the model's "recency wins" merge behaviour.
- **The route model receives only headlines, not full bodies.** Full bodies are loaded only for the topics the route model assigns sources to. A batch of 50 sources thus issues at most 1 route call + up to 50 reconcile calls (one per topic touched, not one per source), bounded by the 4-way concurrency.
- **The reconcile call uses the default request transport, not streaming.** Only the route call sets `forceStreaming = true`; the reconcile call relies on the underlying client's default transport choice.
- **Outcome codes are append-only and never renumbered.** They appear in persisted telemetry and any backend cross-references.
- **Sweep failures are isolated per repo.** A single per-repo failure is recorded in the result and the sweep continues. Multi-repo callers report failed-repo count and exit non-zero only when at least one repo failed.

## Shared Behavior

- **Topic extraction at commit time.** Each commit summary may already carry topic blocks generated at commit time. The ingest pipeline consumes the commit summary as a single source body (it does not re-extract topics from the summary); the route model decides which topic page(s) the summary's content belongs to. See spec 12 (Multi-Topic Commit Summary Generation) for how summary topics are produced.
- **Squash and rebase reordering.** Squash consolidation (spec 13) and amend/rebase migration (specs 39-41) rewrite the commit summary collection upstream of the pipeline. The ingest pipeline tolerates these reorderings because its high-water mark is keyed by commit hash (a squashed-away commit is gone from the source timeline and is never reconciled out of pages it was already folded into; a newly-introduced squash commit surfaces as a fresh pending source under its new hash and is routed and reconciled like any other source).
- **Queue worker dispatch.** The queue worker (spec 34) runs the ingest phase **after** it has drained all summary entries and released both entry-level locks (the per-cwd summary-drain lock and the per-vault write lock). The ingest phase runs under a **separate** per-worktree ingest lock (spec 259), concurrently with any same-repo summary successor — it does **not** hold the summary-drain lock for the duration. The pipeline does not interact with the queue directly; it is called with an `IngestOperation` describing the trigger tag and an injected write guard.
- **Vault write lock.** The compile entry points and the queue worker share one vault-write lock keyed off the memory bank root, and it is the same lock the sync engine uses. All three now use the **identical** acquisition shape: **per individual write**, in bounded-wait mode, through the write guard — releasing the orphan-write lock (nested inside) and then the vault lock between writes, with the reconcile model calls in between holding no lock. Neither compile entry point holds the lock across its pass any more, and neither fail-fasts on it; the per-write re-acquire is what keeps a long ingest from blocking a concurrent commit-summary worker while still preventing on-disk writes from interleaving with a sync round. The only place a busy acquisition is treated as fatal is the single-repo compile's rebuild reset. See spec 171 for the lock and spec 259 for the ingest lock and its deferred hand-off.
- **Search index warming.** After a successful drain at a compile entry point, the local search index is best-effort rebuilt so the next query rarely pays a lazy rebuild. A failure here never fails the compile. (Search internals: specs 137-139.)
- **Memory bank repo discovery.** The all-repos sweep delegates target enumeration to the memory-bank repo discoverer, which scans the configured folder for directories carrying a memory-bank index file. Discovery is out of scope here; only the contract (`folder`, `kbRoot`, optional `repoIdentity`) is consumed.
- **Storage provider abstraction.** Reads and writes go through one of two providers (the orphan branch storage or the folder layout storage). The pipeline reads the same canonical paths (`topics/index.json`, `topics/<slug>.json`, `topics/processed.json`) regardless of provider. Only the folder provider advertises the wiki render hook; the orphan provider leaves no visible wiki layer.
