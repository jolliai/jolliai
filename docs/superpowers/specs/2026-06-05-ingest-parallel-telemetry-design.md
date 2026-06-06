# Knowledge-Compile — Parallel Reconcile, Structured Error Codes & Run Telemetry

**Date:** 2026-06-05
**Status:** Design approved; ready for implementation-plan.
**Related:** [Topic KB SP3 — Trigger / CLI / Wiki Render](2026-06-03-topic-kb-03-trigger-cli-render-design.md)
**Reference (pattern source, NOT reused engine):** User-Defined Workflow 架构分析 — `jolli` repo at `docs/superpowers/specs/2026-06-05-user-defined-workflow-architecture-analysis.md` (cross-repo; server-side engine, not reused here)

---

## 1. Purpose

Borrow three low-risk patterns from the Jolli backend's user-defined-workflow engine and apply them to the existing local knowledge-compile (topic-KB ingest) pipeline. **Compile stays a fixed, deterministic, local pipeline.** We do not adopt the backend's agentic coordinator / sub-agent fan-out / E2B sandbox / user-configurable `WorkflowConfiguration` — those exist to let users define arbitrary server-side workflows and are a mismatch for a frequent, bounded, must-be-cheap post-commit operation.

The three borrowed patterns:

1. **Parallel reconcile** — the backend's static `per-doc` fan-out (partition → parallel same-agent → merge), minus the runtime LLM coordinator. Today reconcile runs one topic at a time, serially.
2. **Structured error codes** — a stable code enum mirroring `WORKFLOW_ERROR_CODES`, replacing today's silent-skip / free-string failures.
3. **Run telemetry** — a local, bounded `ingest-runs.json` ring buffer, the on-disk equivalent of the backend's per-run `stats` JSONB.

## 2. Decisions (locked in brainstorming)

- **Parallel only the LLM work; keep all writes serial.** `saveTopicPage` writes to the orphan branch via `commit-tree` + `update-ref` (DualWrite); concurrent writes would race the ref. The safe boundary is: parallelize the side-effect-free part (read old page + load source bodies + reconcile call + parse), then apply results (`saveTopicPage` / index upsert / `failedRefs` aggregation) serially.
- **`RECONCILE_CONCURRENCY = 4`, hard-coded, not configurable.** Does not enter `LlmConfig`. Safe for both credential modes (direct Anthropic, jolli proxy).
- **Stable `IngestCode` enum** at the real failure points; per-topic failures are recorded but do **not** terminate the drain (existing "hold sources, retry next time" semantics preserved).
- **`ingest-runs.json` ring buffer**, `MAX_RUNS = 20`, in `<projectDir>/.jolli/jollimemory/` (next to `ingest-cooldown.json`, gitignored). Both the queue path and the CLI path append one record per `drainIngest` call.

## 3. Out of scope (intentionally unchanged)

- Trigger / cooldown / `IngestTrigger`, dedup, and `IngestOperation` shape.
- `StorageProvider` and the orphan-branch / folder write paths.
- The `route` and `reconcile` prompt templates (`PromptTemplates.ts`).
- Wiki render (`TopicWikiRenderer` / `WikiMarkdownBuilder`).
- Recall (still reads raw per-branch summaries; see SP3 §3).
- The mark-processed invariant ("a source is processed iff every topic it targeted succeeded") — preserved verbatim, only its `failedRefs` population moves from in-loop to a post-join aggregation step.

## 4. Parallel reconcile — `IngestPipeline.ts`

Split the serial loop at [`IngestPipeline.ts:83-154`](../../../cli/src/core/IngestPipeline.ts#L83-L154) into two phases.

### 4.1 Parallel phase (pure, no side effects)

Each `[slug, assignment]` in `plan.assignments` maps to an async task returning a discriminated union:

```ts
type ReconcileOutcome =
  | { kind: "ok"; slug: string; page: TopicPage; indexEntry: TopicIndexEntry }
  | { kind: "failed"; slug: string; refs: SourceRef[]; code: IngestCode };
```

The task body is today's loop body verbatim, minus the writes:

1. `current = assignment.isNew ? null : await readTopicPage(slug, cwd)` — read-only, concurrency-safe.
2. Load source bodies in chronological order (`compareSourceRefs`); skip vanished sources (`loadSourceContent === null`).
3. Empty bodies → `{ kind: "failed", code: NO_SOURCE_CONTENT }`.
4. `callLlm({ action: "reconcile", ... })`.
   - `stopReason === "max_tokens"` → `{ kind: "failed", code: RECONCILE_TRUNCATED }`.
   - `parseReconciledPage` returns null → `{ kind: "failed", code: RECONCILE_PARSE_FAILED }`.
5. Build the `TopicPage` + `TopicIndexEntry` (using the pure helpers `mergeRefs`, `branchesOf`) → `{ kind: "ok", page, indexEntry }`.

Run via a new bounded-concurrency helper:

```ts
mapWithConcurrency<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]>
```

- New file `cli/src/core/Concurrency.ts` (small, generic, independently testable).
- `allSettled` semantics: a task that throws is converted to a `failed` outcome for that slug (it never rejects the whole batch). A thrown task with no recoverable code maps to `RECONCILE_PARSE_FAILED` as the conservative default.
- Preserves no ordering guarantee in the result list; the serial phase is order-independent.

### 4.2 Serial apply phase (side effects, unchanged order semantics)

Walk the outcomes:

- `ok` → `await saveTopicPage(page, cwd)`; `upsertIndexEntry(nextIndex, indexEntry)`; `touchedSlugs.push(slug)`; `reconcileCallsThisBatch++`.
- `failed` → `for (const ref of refs) failedRefs.add(ref)`; record `{ slug, code }` into the batch's `topicFailures`.

Then `if (touchedSlugs.length > 0) await saveTopicIndex(nextIndex, cwd)` (unchanged), and the existing mark-processed block ([`IngestPipeline.ts:160-174`](../../../cli/src/core/IngestPipeline.ts#L160-L174)) runs verbatim. Because every reconcile has settled before this point, `failedRefs` is fully populated and the resulting `succeeded` set is identical to today's serial computation.

### 4.3 Constant

`const RECONCILE_CONCURRENCY = 4;` in `IngestPipeline.ts`. Passed to `mapWithConcurrency`. Not surfaced in config.

## 5. Structured error codes — `IngestErrors.ts` (new)

```ts
export const INGEST_CODES = {
  OK: "OK",
  NO_PENDING: "NO_PENDING",
  CREDENTIAL_MISSING: "CREDENTIAL_MISSING",
  ROUTE_FAILED: "ROUTE_FAILED",
  RECONCILE_TRUNCATED: "RECONCILE_TRUNCATED",
  RECONCILE_PARSE_FAILED: "RECONCILE_PARSE_FAILED",
  NO_SOURCE_CONTENT: "NO_SOURCE_CONTENT",
  ITERATION_GUARD: "ITERATION_GUARD",
} as const;
export type IngestCode = (typeof INGEST_CODES)[keyof typeof INGEST_CODES];
```

Wiring (minimal):

- `IngestResult.error?: string` → `errorCode?: IngestCode`. The `plan.error` route-failure path ([`IngestPipeline.ts:73-76`](../../../cli/src/core/IngestPipeline.ts#L73-L76)) sets `ROUTE_FAILED`; empty pending sets `NO_PENDING`.
- Per-topic failures carry their `code` in the `failed` outcome (§4.1) and aggregate into the run record's `topicFailures` — they do **not** stop the drain.
- `CREDENTIAL_MISSING` is produced at the existing silent-skip point in [`QueueWorker.runIngestFromQueue`](../../../cli/src/hooks/QueueWorker.ts) — no longer silent; it now leaves a run record (aligns with the project's "a WARN-only branch is a dead signal" principle: detect → leave a trace + a manual exit).
- `ITERATION_GUARD` is produced at the existing guard hit ([`IngestPipeline.ts:208`](../../../cli/src/core/IngestPipeline.ts#L208)).

The codes feed both the telemetry record (§6) and the `jolli compile` human-readable summary.

## 6. Run telemetry — `IngestRunStore.ts` (new)

A run = one `drainIngest` call. Stored at `getJolliMemoryDir(cwd)/ingest-runs.json` (next to `ingest-cooldown.json`).

```ts
interface IngestRunRecord {
  startedAt: string;            // ISO8601, injected clock (test determinism)
  durationMs: number;
  triggeredBy: "post-merge" | "recall-miss" | "manual";
  outcome: IngestCode;          // terminal code: OK / NO_PENDING / CREDENTIAL_MISSING / ROUTE_FAILED / ITERATION_GUARD
  batches: number;
  ingested: number;             // count of mark-processed sources
  touchedSlugs: number;
  routeCalls: number;           // == batches
  reconcileCalls: number;       // cumulative reconcile LLM calls across batches
  topicFailures: { slug: string; code: IngestCode }[];
}
```

- Ring buffer: `MAX_RUNS = 20`. `appendIngestRun(cwd, record)` reads → push → `slice(-MAX_RUNS)` → write. Missing/corrupt file → treated as empty array (repo's standard store tolerance).
- `readIngestRuns(cwd): Promise<IngestRunRecord[]>` for the CLI / future surfacing.

Wiring — **recording is centralized inside `drainIngest`**, so it covers all three callers without per-call-site duplication:

- `drainIngest` accepts a `triggeredBy` via `IngestOptions` (default `"manual"`), accumulates the run fields (`batches`, `ingested`, distinct `touchedSlugs`, `reconcileCalls`, `outcome`, `topicFailures`) across its per-batch `IngestResult`s, measures `durationMs` with the injected clock, and calls `appendIngestRun(cwd, record)` before returning. Its return widens from `{ batches, ingested }` to also expose `outcome` + `topicFailures` (so CLI callers can print them).
- The three `drainIngest` callers only pass their `triggeredBy`:
  - [`QueueWorker.runIngestFromQueue`](../../../cli/src/hooks/QueueWorker.ts) — `{ triggeredBy: op.triggeredBy }`.
  - [`CompileCommand.compileSingleRepo`](../../../cli/src/commands/CompileCommand.ts) — `{ triggeredBy: "manual" }`; prints a human-readable summary including `outcome` + `topicFailures` (not just `{ batches, ingested }`).
  - [`MultiRepoCompile.compileAllRepos`](../../../cli/src/core/MultiRepoCompile.ts) — `{ triggeredBy: "manual" }` (per repo); the sweep path is now recorded too.
- **`CREDENTIAL_MISSING` is the one exception** — it occurs *before* `drainIngest` is reached. The two **per-cwd** guards (`runIngestFromQueue`, `compileSingleRepo`) write a one-off `CREDENTIAL_MISSING` record via a shared `appendCredentialMissingRun(cwd, triggeredBy)` helper. The `compileSweep` guard has **no per-repo cwd** (it fails before resolving repos, and `ingest-runs.json` is per-project) → it stays console-only, as today. With credentials present, the sweep records normally per repo through the centralized `drainIngest` path.
- Clock injected via the existing `IngestOptions.nowIso` convention for deterministic tests.

## 7. Components / files

| File | Change |
|---|---|
| `cli/src/core/Concurrency.ts` | new — generic `mapWithConcurrency(items, limit, task)` (allSettled semantics) |
| `cli/src/core/IngestErrors.ts` | new — `INGEST_CODES` const enum + `IngestCode` type |
| `cli/src/core/IngestRunStore.ts` | new — `IngestRunRecord`, `appendIngestRun`, `readIngestRuns` (ring buffer, MAX_RUNS=20) |
| `cli/src/core/IngestPipeline.ts` | split reconcile into parallel(pure) + serial(apply); `errorCode` on `IngestResult`; `triggeredBy` in `IngestOptions`; widen `drainIngest` result + centralize `appendIngestRun` inside it |
| `cli/src/hooks/QueueWorker.ts` | `runIngestFromQueue`: pass `{ triggeredBy: op.triggeredBy }`; emit `CREDENTIAL_MISSING` record on skip |
| `cli/src/commands/CompileCommand.ts` | pass `{ triggeredBy: "manual" }`; emit `CREDENTIAL_MISSING` record on skip; print outcome + topicFailures summary |
| `cli/src/core/MultiRepoCompile.ts` | pass `{ triggeredBy: "manual" }` per repo (sweep path now recorded via centralized append) |

## 8. Testing (CLI floor: 97% stmt / 96% br / 97% fn / 97% line)

- `Concurrency.mapWithConcurrency`: never exceeds the limit (instrument an active-count high-water mark); a throwing task degrades to a recorded failure without rejecting the batch; result independent of completion order.
- `IngestRunStore`: `appendIngestRun` round-trips; truncates to 20 keeping the newest; corrupt/missing file → empty array.
- `IngestPipeline`: route-fail → `ROUTE_FAILED` + nothing marked; the three per-topic failure modes (`RECONCILE_TRUNCATED` / `RECONCILE_PARSE_FAILED` / `NO_SOURCE_CONTENT`) each hold their sources and the mark-processed invariant is unchanged vs the pre-parallel behavior (golden comparison on `succeeded` set); a mixed batch (some ok, some failed) marks exactly the fully-successful sources; `reconcileCalls`/`touchedSlugs` counts are correct.
- `QueueWorker.runIngestFromQueue`: credential-missing writes one `CREDENTIAL_MISSING` record and skips; a normal ingest writes one `OK` record with `triggeredBy` from the op.
- `CompileCommand`: `manual` run appends a record and prints the outcome summary; no-key guard unchanged.

## 9. Risks / explicit trade-offs

- **Concurrency 4 is a guess.** Tuned after dogfooding; hard-coded keeps the config surface flat (deliberate, per "fewer knobs"). If a credential mode rate-limits, the failure surfaces as per-topic `RECONCILE_*` codes (sources held, retried next drain) rather than data loss.
- **Parallel-LLM / serial-write** leaves write throughput unchanged; the win is purely latency on the LLM-bound phase (the dominant cost). Accepted over full parallelism, which would race the orphan-branch ref.
- **Ring buffer caps history at 20 runs.** No long-term audit; this is local observability, not the backend's queryable Job history. Accepted.
- **No new public CLI surface for run history yet.** `readIngestRuns` exists for a future `jolli compile --history` or settings view; not built here (YAGNI).
