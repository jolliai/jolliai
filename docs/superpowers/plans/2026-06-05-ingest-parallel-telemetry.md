# Ingest Parallel Reconcile, Error Codes & Run Telemetry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parallelize the topic-KB reconcile stage (LLM calls only, writes stay serial), add a stable `IngestCode` enum at the real failure points, and record per-run telemetry to a bounded `ingest-runs.json` ring buffer.

**Architecture:** Reconcile becomes a two-phase split inside `ingestPendingBatch`: a side-effect-free parallel phase (`mapWithConcurrency`, limit 4) that produces a per-topic discriminated outcome, then a serial apply phase that does all `saveTopicPage`/index writes — avoiding orphan-branch ref races. Telemetry is centralized inside `drainIngest` (covers all three callers); `CREDENTIAL_MISSING` is recorded at the two per-cwd guards.

**Tech Stack:** TypeScript (ESM, Node 22.5+), Vitest, Biome (tabs, 120 col). CLI coverage floor: 97% stmt / 96% br / 97% fn / 97% line.

**Spec:** [docs/superpowers/specs/2026-06-05-ingest-parallel-telemetry-design.md](../specs/2026-06-05-ingest-parallel-telemetry-design.md)

---

## Project convention overrides (read first)

Per this project's standing preference (`feedback_no_per_task_commit_and_test`): **tasks do NOT include per-task `npm run all` or per-task `git commit` steps.** Each task only writes its test + implementation code. A single final task (Task 8) runs the full `npm run all` gate once and makes one commit. Worker may still run an individual test file while iterating, but it is not a mandated step.

DCO sign-off is required on the final commit (`git commit -s`). No `Co-Authored-By: Claude` / `🤖 Generated` trailers.

---

## File Structure

| File | Responsibility |
|---|---|
| `cli/src/core/Concurrency.ts` | **new** — generic `mapWithConcurrency(items, limit, task)`; throwing task degrades to a result, never rejects the batch |
| `cli/src/core/IngestErrors.ts` | **new** — `INGEST_CODES` const map + `IngestCode` type |
| `cli/src/core/IngestRunStore.ts` | **new** — `IngestRunRecord` type, `appendIngestRun`, `readIngestRuns`, `appendCredentialMissingRun` (ring buffer, MAX_RUNS=20, per-project dir) |
| `cli/src/core/IngestPipeline.ts` | **modify** — split reconcile into parallel(pure)+serial(apply); `errorCode`/`reconcileCalls`/`topicFailures` on `IngestResult`; `triggeredBy` in `IngestOptions`; centralize `appendIngestRun` inside `drainIngest` |
| `cli/src/hooks/QueueWorker.ts` | **modify** — `runIngestFromQueue`: pass `{ triggeredBy: op.triggeredBy }`; record `CREDENTIAL_MISSING` on skip |
| `cli/src/commands/CompileCommand.ts` | **modify** — `compileSingleRepo`: pass `{ triggeredBy: "manual" }`, record `CREDENTIAL_MISSING` on skip, print outcome+failures |
| `cli/src/core/MultiRepoCompile.ts` | **modify** — pass `{ triggeredBy: "manual" }` per repo |

Test files: `Concurrency.test.ts`, `IngestRunStore.test.ts` (new); extend `IngestPipeline.test.ts`, `QueueWorker.test.ts` (or the file holding `runIngestFromQueue` tests), `CompileCommand.test.ts`.

---

## Task 1: `Concurrency.ts` — bounded-concurrency map

**Files:**
- Create: `cli/src/core/Concurrency.ts`
- Test: `cli/src/core/Concurrency.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// cli/src/core/Concurrency.test.ts
import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "./Concurrency.js";

const defer = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("mapWithConcurrency", () => {
	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		const gates = Array.from({ length: 10 }, () => defer());
		const task = async (i: number) => {
			active++;
			peak = Math.max(peak, active);
			await gates[i].promise;
			active--;
			return i * 2;
		};
		const items = Array.from({ length: 10 }, (_, i) => i);
		const run = mapWithConcurrency(items, 3, task);
		// release all gates on the next tick so up to 3 can be in-flight at once
		await Promise.resolve();
		for (const g of gates) g.resolve();
		const out = await run;
		expect(peak).toBeLessThanOrEqual(3);
		expect(out).toEqual(items.map((i) => i * 2));
	});

	it("preserves input order regardless of completion order", async () => {
		const task = async (i: number) => {
			await new Promise((r) => setTimeout(r, i === 0 ? 20 : 0));
			return i;
		};
		const out = await mapWithConcurrency([0, 1, 2], 3, task);
		expect(out).toEqual([0, 1, 2]);
	});

	it("degrades a throwing task via the onError mapper instead of rejecting", async () => {
		const out = await mapWithConcurrency(
			[1, 2, 3],
			2,
			async (i) => {
				if (i === 2) throw new Error("boom");
				return `ok:${i}`;
			},
			(item, err) => `err:${item}:${(err as Error).message}`,
		);
		expect(out).toEqual(["ok:1", "err:2:boom", "ok:3"]);
	});

	it("re-throws when no onError mapper is supplied", async () => {
		await expect(
			mapWithConcurrency([1], 1, async () => {
				throw new Error("nope");
			}),
		).rejects.toThrow("nope");
	});

	it("returns empty array for empty input", async () => {
		expect(await mapWithConcurrency([], 4, async (i) => i)).toEqual([]);
	});
});
```

- [ ] **Step 2: Implement `Concurrency.ts`**

```ts
// cli/src/core/Concurrency.ts
/**
 * Concurrency — generic bounded-parallelism map. Runs `task` over `items` with
 * at most `limit` in flight at once, preserving input order in the result.
 *
 * When `onError` is supplied, a task that throws is converted to a result via
 * `onError(item, err)` instead of rejecting the whole batch — callers that want
 * per-item degradation (e.g. the ingest reconcile fan-out) pass it. Without
 * `onError`, the first thrown error rejects the returned promise.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
	onError?: (item: T, err: unknown, index: number) => R,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workerCount = Math.min(Math.max(1, limit), items.length || 1);

	async function worker(): Promise<void> {
		while (next < items.length) {
			const index = next++;
			const item = items[index];
			try {
				results[index] = await task(item, index);
			} catch (err) {
				if (!onError) throw err;
				results[index] = onError(item, err, index);
			}
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}
```

---

## Task 2: `IngestErrors.ts` — stable error codes

**Files:**
- Create: `cli/src/core/IngestErrors.ts`

(No dedicated test: this is a pure constant map exercised by every downstream consumer's tests — its statements/types are covered transitively. Coverage floor is met by Tasks 4–7.)

- [ ] **Step 1: Implement `IngestErrors.ts`**

```ts
// cli/src/core/IngestErrors.ts
/**
 * IngestErrors — stable, structured outcome codes for the topic-KB ingest
 * pipeline. The local-CLI counterpart of the backend's WORKFLOW_ERROR_CODES:
 * one code per real failure point, surfaced in run telemetry (IngestRunStore)
 * and the `jolli compile` summary. Codes are append-only — never renumber.
 */
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

---

## Task 3: `IngestRunStore.ts` — telemetry ring buffer

**Files:**
- Create: `cli/src/core/IngestRunStore.ts`
- Test: `cli/src/core/IngestRunStore.test.ts`

Mirrors `IngestTrigger.ts`: per-project gitignored dir via `getJolliMemoryDir(cwd)`, plain `node:fs/promises`, atomic write, corrupt/missing → empty. **Not** the StorageProvider/orphan branch.

- [ ] **Step 1: Write the failing tests**

```ts
// cli/src/core/IngestRunStore.test.ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getJolliMemoryDir } from "../Logger.js";
import { INGEST_CODES } from "./IngestErrors.js";
import { appendCredentialMissingRun, appendIngestRun, type IngestRunRecord, readIngestRuns } from "./IngestRunStore.js";

let cwd: string;
const rec = (over: Partial<IngestRunRecord> = {}): IngestRunRecord => ({
	startedAt: "2026-06-05T00:00:00.000Z",
	durationMs: 5,
	triggeredBy: "manual",
	outcome: INGEST_CODES.OK,
	batches: 1,
	ingested: 3,
	touchedSlugs: 2,
	routeCalls: 1,
	reconcileCalls: 2,
	topicFailures: [],
	...over,
});

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "ingest-runs-"));
});
afterEach(async () => {
	await rm(cwd, { recursive: true, force: true });
});

describe("IngestRunStore", () => {
	it("round-trips a record (missing file starts empty)", async () => {
		expect(await readIngestRuns(cwd)).toEqual([]);
		await appendIngestRun(cwd, rec({ ingested: 7 }));
		const runs = await readIngestRuns(cwd);
		expect(runs).toHaveLength(1);
		expect(runs[0].ingested).toBe(7);
	});

	it("keeps only the newest 20 runs", async () => {
		for (let i = 0; i < 25; i++) await appendIngestRun(cwd, rec({ ingested: i }));
		const runs = await readIngestRuns(cwd);
		expect(runs).toHaveLength(20);
		expect(runs[0].ingested).toBe(5); // oldest 5 dropped
		expect(runs[19].ingested).toBe(24);
	});

	it("treats a corrupt file as empty", async () => {
		await writeFile(join(getJolliMemoryDir(cwd), "ingest-runs.json"), "{not json", "utf-8");
		expect(await readIngestRuns(cwd)).toEqual([]);
		await appendIngestRun(cwd, rec());
		expect(await readIngestRuns(cwd)).toHaveLength(1);
	});

	it("appendCredentialMissingRun records a CREDENTIAL_MISSING outcome", async () => {
		await appendCredentialMissingRun(cwd, "post-merge");
		const runs = await readIngestRuns(cwd);
		expect(runs[0].outcome).toBe(INGEST_CODES.CREDENTIAL_MISSING);
		expect(runs[0].triggeredBy).toBe("post-merge");
		expect(runs[0].batches).toBe(0);
	});
});
```

- [ ] **Step 2: Implement `IngestRunStore.ts`**

```ts
// cli/src/core/IngestRunStore.ts
/**
 * IngestRunStore — a bounded ring buffer of recent topic-KB ingest runs, the
 * local on-disk equivalent of the backend's per-run stats JSONB. One record
 * per drainIngest call. Path: `<projectDir>/.jolli/jollimemory/ingest-runs.json`
 * (per-project, gitignored — sibling of ingest-cooldown.json). Plain fs, NOT
 * the StorageProvider/orphan branch. Corrupt/missing file → empty.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getJolliMemoryDir } from "../Logger.js";
import type { IngestOperation } from "../Types.js";
import { INGEST_CODES, type IngestCode } from "./IngestErrors.js";

const RUNS_FILE = "ingest-runs.json";
const MAX_RUNS = 20;

export interface IngestRunRecord {
	readonly startedAt: string; // ISO 8601
	readonly durationMs: number;
	readonly triggeredBy: IngestOperation["triggeredBy"];
	readonly outcome: IngestCode;
	readonly batches: number;
	readonly ingested: number;
	readonly touchedSlugs: number;
	readonly routeCalls: number;
	readonly reconcileCalls: number;
	readonly topicFailures: ReadonlyArray<{ readonly slug: string; readonly code: IngestCode }>;
}

export async function readIngestRuns(cwd: string): Promise<IngestRunRecord[]> {
	try {
		const raw = await readFile(join(getJolliMemoryDir(cwd), RUNS_FILE), "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed) ? (parsed as IngestRunRecord[]) : [];
	} catch {
		return [];
	}
}

export async function appendIngestRun(cwd: string, record: IngestRunRecord): Promise<void> {
	const dir = getJolliMemoryDir(cwd);
	await mkdir(dir, { recursive: true });
	const existing = await readIngestRuns(cwd);
	const next = [...existing, record].slice(-MAX_RUNS);
	await atomicWriteFile(join(dir, RUNS_FILE), JSON.stringify(next, null, "\t"));
}

/** Records a one-off run for the pre-drain credential guard (no batches ran). */
export async function appendCredentialMissingRun(
	cwd: string,
	triggeredBy: IngestOperation["triggeredBy"],
	nowIso: string = new Date().toISOString(),
): Promise<void> {
	await appendIngestRun(cwd, {
		startedAt: nowIso,
		durationMs: 0,
		triggeredBy,
		outcome: INGEST_CODES.CREDENTIAL_MISSING,
		batches: 0,
		ingested: 0,
		touchedSlugs: 0,
		routeCalls: 0,
		reconcileCalls: 0,
		topicFailures: [],
	});
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
	const tmp = `${filePath}.tmp`;
	await writeFile(tmp, content, "utf-8");
	try {
		await rename(tmp, filePath);
		/* v8 ignore start -- Windows EPERM/EACCES rename fallback (same as IngestTrigger). */
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "EPERM" || code === "EACCES") {
			await writeFile(filePath, content, "utf-8");
			await rm(tmp, { force: true });
		} else {
			throw err;
		}
	}
	/* v8 ignore stop */
}
```

---

## Task 4: Parallel reconcile + error codes in `IngestPipeline.ts`

**Files:**
- Modify: `cli/src/core/IngestPipeline.ts` (imports; `IngestResult` shape; reconcile section [`:78-154`](../../../cli/src/core/IngestPipeline.ts#L78-L154); route-fail + empty-pending returns)
- Test: `cli/src/core/IngestPipeline.test.ts` (extend)

- [ ] **Step 1: Add imports + `RECONCILE_CONCURRENCY` constant**

At the top of `IngestPipeline.ts`, add to the imports:

```ts
import { mapWithConcurrency } from "./Concurrency.js";
import { INGEST_CODES, type IngestCode } from "./IngestErrors.js";
```

Add beside the other module constants (after `RECONCILE_MAX_TOKENS`):

```ts
const RECONCILE_CONCURRENCY = 4; // fan out reconcile LLM calls; writes stay serial
```

- [ ] **Step 2: Widen `IngestResult`**

Replace the `IngestResult` interface (currently ending with `readonly error?: string;`) with:

```ts
export interface IngestResult {
	readonly ingested: number;
	readonly touchedSlugs: string[];
	readonly done: boolean;
	/** Total pending sources observed at the start of this batch (before slicing to N). */
	readonly pendingCount: number;
	/** Reconcile LLM calls actually issued this batch (excludes NO_SOURCE_CONTENT topics). */
	readonly reconcileCalls: number;
	/** Per-topic failures this batch — sources held for retry, drain continues. */
	readonly topicFailures: { slug: string; code: IngestCode }[];
	/** Batch-terminal code (route failure / empty). Absent on a normal batch. */
	readonly errorCode?: IngestCode;
}
```

- [ ] **Step 3: Update the empty-pending and route-fail returns**

Empty-pending early return ([`:56`](../../../cli/src/core/IngestPipeline.ts#L56)):

```ts
	if (pending.length === 0)
		return { ingested: 0, touchedSlugs: [], done: true, pendingCount: 0, reconcileCalls: 0, topicFailures: [] };
```

Route-fail return ([`:73-76`](../../../cli/src/core/IngestPipeline.ts#L73-L76)):

```ts
	const plan = parseRoutePlan(routeResult.text ?? "", routeResult.stopReason, batch);
	if (plan.error) {
		log.error("Route failed (%s) -- marking nothing, will retry", plan.error);
		return {
			ingested: 0,
			touchedSlugs: [],
			done: false,
			pendingCount: pending.length,
			reconcileCalls: 0,
			topicFailures: [],
			errorCode: INGEST_CODES.ROUTE_FAILED,
		};
	}
```

- [ ] **Step 4: Replace the serial reconcile loop with parallel-then-serial**

Replace the entire block from `// -- Reconcile each affected topic` through the `saveTopicIndex` call (currently [`:78-158`](../../../cli/src/core/IngestPipeline.ts#L78-L158)) with:

```ts
	// -- Reconcile: parallel LLM phase (pure) -> serial apply phase (writes) ---
	type ReconcileOutcome =
		| { kind: "ok"; slug: string; page: TopicPage; indexEntry: TopicIndexEntry }
		| { kind: "failed"; slug: string; refs: SourceRef[]; code: IngestCode };

	const assignments = [...plan.assignments];
	const outcomes = await mapWithConcurrency<[string, (typeof assignments)[number][1]], ReconcileOutcome>(
		assignments,
		RECONCILE_CONCURRENCY,
		async ([slug, assignment]) => {
			const current = assignment.isNew ? null : await readTopicPage(slug, cwd);
			const title = current?.title ?? assignment.title ?? slug;

			// Feed source bodies oldest -> newest so reconcile applies recency-wins.
			const orderedRefs = [...assignment.refs].sort(compareSourceRefs);
			const bodies: string[] = [];
			const foldedRefs: SourceRef[] = [];
			for (const ref of orderedRefs) {
				const body = await loadSourceContent(ref, cwd, readStorage);
				if (body === null) continue; // vanished source -- skip, do not fail the page
				bodies.push(`### (${ref.type}, ${ref.timestamp})\n${body}`);
				foldedRefs.push(ref);
			}
			if (bodies.length === 0) {
				log.warn("Topic %s had no loadable source content -- skipping", slug);
				return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.NO_SOURCE_CONTENT };
			}

			const result = await callLlm({
				action: "reconcile",
				params: {
					topicTitle: title,
					currentPage: current?.content ?? "(new topic -- no existing page)",
					sources: bodies.join("\n\n"),
				},
				model: resolveModelId(config.model),
				maxTokens: RECONCILE_MAX_TOKENS,
				apiKey: config.apiKey,
				jolliApiKey: config.jolliApiKey,
			});
			if (result.stopReason === "max_tokens") {
				log.error("Reconcile truncated for topic %s -- keeping old page, holding sources", slug);
				return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.RECONCILE_TRUNCATED };
			}
			const parsed = parseReconciledPage(result.text ?? "", slug, title);
			if (!parsed) {
				log.error("Reconcile produced no topic block for %s -- keeping old page, holding sources", slug);
				return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.RECONCILE_PARSE_FAILED };
			}

			const sourceRefs = mergeRefs(current?.sourceRefs ?? [], foldedRefs);
			// relatedBranches is authoritative from the contributing sources' branches,
			// NOT the LLM's advisory `---RELATEDBRANCHES---` echo (often "(unknown)").
			const relatedBranches = branchesOf(sourceRefs);
			const page: TopicPage = {
				schemaVersion: 1,
				stableSlug: slug,
				title: parsed.title,
				content: parsed.content,
				relatedBranches,
				sourceRefs,
				lastUpdatedAt: nowIso,
			};
			const indexEntry: TopicIndexEntry = {
				stableSlug: slug,
				title: parsed.title,
				summary: parsed.summary,
				relatedBranches,
				sourceRefs,
				lastUpdatedAt: nowIso,
			};
			return { kind: "ok", slug, page, indexEntry };
		},
		// A task that throws (unexpected) degrades to a held parse failure rather
		// than aborting the whole batch.
		([slug, assignment], err) => {
			log.error("Reconcile threw for topic %s: %s -- holding sources", slug, (err as Error).message);
			return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.RECONCILE_PARSE_FAILED };
		},
	);

	// -- Serial apply phase (side effects; orphan-branch writes never race) ----
	const failedRefs = new Set<SourceRef>();
	const touchedSlugs: string[] = [];
	const topicFailures: { slug: string; code: IngestCode }[] = [];
	const nextIndex: TopicIndex = { schemaVersion: 1, topics: [...index.topics] };
	let reconcileCalls = 0;
	for (const outcome of outcomes) {
		// `ok` always issued a reconcile LLM call; a `failed` issued one unless it
		// short-circuited on NO_SOURCE_CONTENT (which never reached callLlm).
		// `outcome.code` only exists on the `failed` variant, so guard via the discriminant.
		const issuedCall = outcome.kind === "ok" || outcome.code !== INGEST_CODES.NO_SOURCE_CONTENT;
		if (issuedCall) reconcileCalls++;
		if (outcome.kind === "ok") {
			await saveTopicPage(outcome.page, cwd);
			upsertIndexEntry(nextIndex, outcome.indexEntry);
			touchedSlugs.push(outcome.slug);
		} else {
			for (const ref of outcome.refs) failedRefs.add(ref);
			topicFailures.push({ slug: outcome.slug, code: outcome.code });
		}
	}

	// Only persist the index when at least one page changed.
	if (touchedSlugs.length > 0) await saveTopicIndex(nextIndex, cwd);
```

- [ ] **Step 5: Update the mark-processed return**

The mark-processed block ([`:160-174`](../../../cli/src/core/IngestPipeline.ts#L160-L174)) is unchanged. Replace the final `return` of `ingestPendingBatch` with:

```ts
	return {
		ingested: succeeded.length,
		touchedSlugs,
		done: pending.length <= batchSize,
		pendingCount: pending.length,
		reconcileCalls,
		topicFailures,
	};
```

- [ ] **Step 6: Add tests for the failure codes + counts (extend `IngestPipeline.test.ts`)**

Append inside the existing `describe("ingestPendingBatch", ...)` block (reuses its mocks `callLlm`, `listPendingSources`, `saveTopicPage`, helpers `s`, `llmText`, `reconcileOut`):

```ts
	it("holds a topic and reports RECONCILE_TRUNCATED without marking its sources", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		const truncated = { ...llmText("reconcile", ""), stopReason: "max_tokens" as const };
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText("route", JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] })),
			)
			.mockResolvedValueOnce(truncated);
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.ingested).toBe(0);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_TRUNCATED" }]);
		expect(r.reconcileCalls).toBe(1);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("reports RECONCILE_PARSE_FAILED when the block is unparseable", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText("route", JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] })),
			)
			.mockResolvedValueOnce(llmText("reconcile", "garbage with no topic block"));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.topicFailures).toEqual([{ slug: "t", code: "RECONCILE_PARSE_FAILED" }]);
		expect(r.reconcileCalls).toBe(1);
	});

	it("returns ROUTE_FAILED and marks nothing when route output is invalid", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([s("c1", "2026-01-01T00:00:00Z")]);
		vi.mocked(callLlm).mockResolvedValueOnce(llmText("route", "not json at all"));
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.errorCode).toBe("ROUTE_FAILED");
		expect(r.ingested).toBe(0);
		expect(vi.mocked(saveProcessedSet)).not.toHaveBeenCalled();
	});

	it("marks only the fully-successful source in a mixed batch (one topic ok, one held)", async () => {
		vi.mocked(listPendingSources).mockResolvedValue([
			s("good", "2026-01-01T00:00:00Z"),
			s("bad", "2026-01-02T00:00:00Z"),
		]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText(
					"route",
					JSON.stringify({
						updates: [],
						newTopics: [
							{ stableSlug: "ok", title: "Ok", sourceIndexes: [0] },
							{ stableSlug: "held", title: "Held", sourceIndexes: [1] },
						],
					}),
				),
			)
			// reconcile order is concurrency-dependent; return by topicTitle, not call order
			.mockImplementation(async (req) => {
				if (req.action === "reconcile") {
					return req.params.topicTitle === "Ok" ? llmText("reconcile", reconcileOut("ok")) : { ...llmText("reconcile", ""), stopReason: "max_tokens" as const };
				}
				return llmText("route", "");
			});
		const r = await ingestPendingBatch("/tmp/x", cfg);
		expect(r.touchedSlugs).toEqual(["ok"]);
		expect(r.topicFailures.map((f) => f.slug)).toEqual(["held"]);
		const marked = vi.mocked(saveProcessedSet).mock.calls[0]?.[0];
		expect(marked?.processed.summary).toEqual(["good"]);
	});
```

> The existing happy-path / chronological-order / un-filed tests must remain green unchanged — the parallel refactor preserves observable behavior. If `callLlm` call-index assertions in an existing test now fail because reconcile order is no longer strictly sequential, switch that assertion to match by `params.topicTitle` (as the mixed-batch test does) rather than positional `mock.calls[1]`.

---

## Task 5: Centralize telemetry inside `drainIngest`

**Files:**
- Modify: `cli/src/core/IngestPipeline.ts` (`IngestOptions`, `drainIngest`)
- Test: `cli/src/core/IngestPipeline.test.ts` (extend, in the `describe("drainIngest", ...)` block)

- [ ] **Step 1: Add `triggeredBy` to `IngestOptions` + import the store**

Add import near the top of `IngestPipeline.ts`:

```ts
import type { IngestOperation } from "../Types.js";
import { appendIngestRun } from "./IngestRunStore.js";
```

Add to the `IngestOptions` interface:

```ts
	/** Tags the telemetry record written by drainIngest. Defaults to "manual". */
	readonly triggeredBy?: IngestOperation["triggeredBy"];
```

- [ ] **Step 2: Rewrite `drainIngest` to aggregate + record one run**

Replace the whole `drainIngest` function ([`:185-212`](../../../cli/src/core/IngestPipeline.ts#L185-L212)) with:

```ts
/** Loops ingestPendingBatch until empty, then records one telemetry run. */
export async function drainIngest(
	cwd: string,
	config: LlmConfig,
	opts?: IngestOptions,
): Promise<{ batches: number; ingested: number; outcome: IngestCode; topicFailures: { slug: string; code: IngestCode }[] }> {
	const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
	const startedAt = opts?.nowIso ?? new Date().toISOString();
	const t0 = performance.now();
	let batches = 0;
	let ingested = 0;
	let reconcileCalls = 0;
	const touched = new Set<string>();
	const topicFailures: { slug: string; code: IngestCode }[] = [];
	let outcome: IngestCode = INGEST_CODES.OK;
	// Adaptive guard from the first batch's pending count: ceil(pending/N)+2 slack.
	let maxIterations = Number.POSITIVE_INFINITY;
	while (batches < maxIterations) {
		const r = await ingestPendingBatch(cwd, config, opts);
		if (batches === 0) {
			maxIterations = Math.ceil(r.pendingCount / batchSize) + 2;
			if (r.pendingCount === 0) outcome = INGEST_CODES.NO_PENDING;
		}
		batches++;
		ingested += r.ingested;
		reconcileCalls += r.reconcileCalls;
		for (const slug of r.touchedSlugs) touched.add(slug);
		topicFailures.push(...r.topicFailures);
		if (r.errorCode) {
			log.error("drainIngest stopping on batch error: %s", r.errorCode);
			outcome = r.errorCode;
			break;
		}
		if (r.done) break;
	}
	if (batches >= maxIterations) {
		log.error("drainIngest hit iteration guard (%d) -- pipeline not draining, stopping", maxIterations);
		outcome = INGEST_CODES.ITERATION_GUARD;
	}

	await appendIngestRun(cwd, {
		startedAt,
		durationMs: Math.round(performance.now() - t0),
		triggeredBy: opts?.triggeredBy ?? "manual",
		outcome,
		batches,
		ingested,
		touchedSlugs: touched.size,
		routeCalls: batches,
		reconcileCalls,
		topicFailures,
	});

	return { batches, ingested, outcome, topicFailures };
}
```

- [ ] **Step 3: Add `drainIngest` telemetry tests (extend `IngestPipeline.test.ts`)**

The existing `drainIngest` describe block mocks the pipeline modules. Add a mock for `IngestRunStore` at the top-level `vi.mock` section (with the others):

```ts
vi.mock("./IngestRunStore.js", () => ({ appendIngestRun: vi.fn() }));
```

And import it in the test imports:

```ts
import { appendIngestRun } from "./IngestRunStore.js";
```

Then, inside `describe("drainIngest", ...)`:

```ts
	it("records one OK run with aggregated counts", async () => {
		vi.mocked(appendIngestRun).mockReset();
		vi.mocked(listPendingSources)
			.mockResolvedValueOnce([s("c1", "2026-01-01T00:00:00Z")])
			.mockResolvedValueOnce([]);
		vi.mocked(callLlm)
			.mockResolvedValueOnce(
				llmText("route", JSON.stringify({ updates: [], newTopics: [{ stableSlug: "t", title: "T", sourceIndexes: [0] }] })),
			)
			.mockResolvedValueOnce(llmText("reconcile", reconcileOut("t")));
		const out = await drainIngest("/tmp/x", cfg, { triggeredBy: "post-merge", nowIso: "2026-06-05T00:00:00.000Z" });
		expect(out.outcome).toBe("OK");
		const rec = vi.mocked(appendIngestRun).mock.calls[0]?.[1];
		expect(rec).toMatchObject({
			triggeredBy: "post-merge",
			outcome: "OK",
			ingested: 1,
			touchedSlugs: 1,
			reconcileCalls: 1,
			startedAt: "2026-06-05T00:00:00.000Z",
		});
		expect(typeof rec?.durationMs).toBe("number");
	});

	it("records NO_PENDING when nothing is pending", async () => {
		vi.mocked(appendIngestRun).mockReset();
		vi.mocked(listPendingSources).mockResolvedValue([]);
		const out = await drainIngest("/tmp/x", cfg);
		expect(out.outcome).toBe("NO_PENDING");
		expect(vi.mocked(appendIngestRun).mock.calls[0]?.[1].triggeredBy).toBe("manual");
	});
```

> If the existing `drainIngest` tests assert on the old return shape `{ batches, ingested }` via `toEqual`, loosen them to `toMatchObject({ batches, ingested })` since the shape now also carries `outcome` + `topicFailures`.

---

## Task 6: Wire `QueueWorker.runIngestFromQueue`

**Files:**
- Modify: `cli/src/hooks/QueueWorker.ts` ([`:513-526`](../../../cli/src/hooks/QueueWorker.ts#L513-L526))
- Test: the test file covering `runIngestFromQueue` (search `runIngestFromQueue` / ingest in `cli/src/hooks/QueueWorker.test.ts`)

- [ ] **Step 1: Update `runIngestFromQueue`**

Replace the function body ([`:513-526`](../../../cli/src/hooks/QueueWorker.ts#L513-L526)) with:

```ts
async function runIngestFromQueue(op: IngestOperation, cwd: string, storage: StorageProvider): Promise<void> {
	const { drainIngest } = await import("../core/IngestPipeline.js");
	const { renderTopicKBWiki } = await import("../core/TopicWikiRenderer.js");
	const { appendCredentialMissingRun } = await import("../core/IngestRunStore.js");
	const config = await loadConfig();
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		log.info("No API key configured — skipping ingest (%s)", op.triggeredBy);
		await appendCredentialMissingRun(cwd, op.triggeredBy);
		return;
	}
	const result = await drainIngest(cwd, config, { triggeredBy: op.triggeredBy });
	log.info("Ingest drained: %d batches, %d sources (%s)", result.batches, result.ingested, op.triggeredBy);
	if (result.ingested > 0) {
		await renderTopicKBWiki(cwd, storage);
	}
}
```

- [ ] **Step 2: Add/adjust the credential-missing test**

In the QueueWorker test file, add (mirroring however that file stubs `loadConfig` + the lazy imports; if `IngestRunStore` is not yet mocked there, mock it):

```ts
// alongside the other vi.mock calls in the QueueWorker test file:
vi.mock("../core/IngestRunStore.js", () => ({ appendCredentialMissingRun: vi.fn(), appendIngestRun: vi.fn() }));
```

```ts
	it("records CREDENTIAL_MISSING and skips when no key is configured", async () => {
		// loadConfig returns no apiKey/jolliApiKey; ANTHROPIC_API_KEY unset
		const { appendCredentialMissingRun } = await import("../core/IngestRunStore.js");
		await runIngestForTest({ type: "ingest", triggeredBy: "recall-miss", createdAt: "2026-06-05T00:00:00Z" }, cwd, storage);
		expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith(cwd, "recall-miss");
	});
```

> `runIngestForTest` is whatever entry the existing tests use to reach `runIngestFromQueue` (it may be the exported `processQueueEntry` with an ingest op, or a direct call). Match the existing harness. If `runIngestFromQueue` is not exported, drive it through the queue-dispatch entry that the file already exercises for ingest, and ensure `ANTHROPIC_API_KEY` is deleted from `process.env` for the test.

---

## Task 7: Wire `CompileCommand` + `MultiRepoCompile`

**Files:**
- Modify: `cli/src/commands/CompileCommand.ts` (`compileSingleRepo` [`:28-60`](../../../cli/src/commands/CompileCommand.ts#L28-L60))
- Modify: `cli/src/core/MultiRepoCompile.ts` ([`:48`](../../../cli/src/core/MultiRepoCompile.ts#L48))
- Test: `cli/src/commands/CompileCommand.test.ts` (extend)

- [ ] **Step 1: `compileSingleRepo` — triggeredBy, credential record, summary**

Add import to `CompileCommand.ts`:

```ts
import { appendCredentialMissingRun } from "../core/IngestRunStore.js";
```

In `compileSingleRepo`, replace the credential guard's body to also record (keep the console error + exit):

```ts
	if (!config.apiKey && !config.jolliApiKey && !process.env.ANTHROPIC_API_KEY) {
		console.error("\n  Error: No API key configured. Run 'jolli enable' to set up.\n");
		await appendCredentialMissingRun(cwd, "manual");
		process.exitCode = 1;
		return;
	}
```

Replace the drain + summary lines ([`:49`](../../../cli/src/commands/CompileCommand.ts#L49) and [`:59`](../../../cli/src/commands/CompileCommand.ts#L59)):

```ts
	const { batches, ingested, outcome, topicFailures } = await drainIngest(cwd, config, { triggeredBy: "manual" });
	// Converge canonical layer to the index (drop pages no longer referenced).
	const index = await readTopicIndex(cwd, storage);
	await purgeTopicPagesExcept(
		index.topics.map((t) => t.stableSlug),
		cwd,
		storage,
	);
	await renderTopicKBWiki(cwd, storage);
	let summary = `\n  Done: ${ingested} source(s) folded in ${batches} batch(es). Wiki rebuilt. [${outcome}]`;
	if (topicFailures.length > 0) {
		summary += `\n  ${topicFailures.length} topic(s) held: ${topicFailures.map((f) => `${f.slug} (${f.code})`).join(", ")}`;
	}
	console.log(`${summary}\n`);
```

- [ ] **Step 2: `MultiRepoCompile` — tag triggeredBy**

In `MultiRepoCompile.ts` [`:48`](../../../cli/src/core/MultiRepoCompile.ts#L48), change the `drainIngest` call to tag the run:

```ts
			const { batches, ingested } = await drainIngest(t.kbRoot, config, {
				...opts,
				readStorage: storage,
				triggeredBy: "manual",
			});
```

- [ ] **Step 3: Extend `CompileCommand.test.ts`**

Mirror the file's existing mock setup (it already mocks `drainIngest` etc.). Make `drainIngest` return the widened shape and assert the summary + credential record:

```ts
// ensure IngestRunStore is mocked alongside the others:
vi.mock("../core/IngestRunStore.js", () => ({ appendCredentialMissingRun: vi.fn() }));
```

```ts
	it("prints the outcome code and held topics in the summary", async () => {
		vi.mocked(drainIngest).mockResolvedValue({
			batches: 1,
			ingested: 2,
			outcome: "OK",
			topicFailures: [{ slug: "held", code: "RECONCILE_TRUNCATED" }],
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await executeCompile({ cwd: "/tmp/repo" });
		const printed = log.mock.calls.map((c) => String(c[0])).join("\n");
		expect(printed).toContain("[OK]");
		expect(printed).toContain("held (RECONCILE_TRUNCATED)");
		log.mockRestore();
	});

	it("records CREDENTIAL_MISSING when no key on a single-repo compile", async () => {
		// configure loadConfig mock to return no keys + delete ANTHROPIC_API_KEY
		const { appendCredentialMissingRun } = await import("../core/IngestRunStore.js");
		await executeCompile({ cwd: "/tmp/repo" });
		expect(vi.mocked(appendCredentialMissingRun)).toHaveBeenCalledWith("/tmp/repo", "manual");
	});
```

> Match the existing file's mock of `loadConfig` / `createStorage` / `readTopicIndex` / `purgeTopicPagesExcept` / `renderTopicKBWiki`. If those aren't mocked yet, add minimal stubs so `compileSingleRepo` runs without touching disk.

---

## Task 8: Verify + single commit

- [ ] **Step 1: Run the full gate**

Run: `npm run all`
Expected: clean → build → lint → test all PASS; CLI coverage ≥ 97/96/97/97.

If coverage dips, add the missing-branch test (most likely the `mapWithConcurrency` re-throw path or the `RECONCILE_PARSE_FAILED`-via-throw degrade path) rather than lowering the threshold.

- [ ] **Step 2: Commit (one commit, DCO signed, no AI co-author trailer)**

```bash
git add cli/src/core/Concurrency.ts cli/src/core/Concurrency.test.ts \
        cli/src/core/IngestErrors.ts \
        cli/src/core/IngestRunStore.ts cli/src/core/IngestRunStore.test.ts \
        cli/src/core/IngestPipeline.ts cli/src/core/IngestPipeline.test.ts \
        cli/src/hooks/QueueWorker.ts cli/src/hooks/QueueWorker.test.ts \
        cli/src/commands/CompileCommand.ts cli/src/commands/CompileCommand.test.ts \
        cli/src/core/MultiRepoCompile.ts
git commit -s -m "feat(ingest): parallel reconcile, structured error codes, run telemetry

Fan out reconcile LLM calls (limit 4) via mapWithConcurrency while keeping
all topic-page/index writes serial (no orphan-branch ref race). Add a
stable IngestCode enum at the real failure points and an ingest-runs.json
ring buffer (last 20 runs) recorded centrally in drainIngest across all
three callers; CREDENTIAL_MISSING recorded at the per-cwd guards."
```

---

## Self-Review notes

- **Spec coverage:** §4 parallel reconcile → Task 4; §5 error codes → Tasks 2,4; §6 telemetry → Tasks 3,5,6,7; §7 file table → Tasks 1–7; §8 tests → each task's test step + Task 8 gate. Centralized-recording correction (3 callers) → Tasks 5,6,7. `CREDENTIAL_MISSING` per-cwd-only → Tasks 6,7 (sweep stays console-only — unchanged, not a task).
- **Type consistency:** `IngestCode` (Task 2) used identically in `IngestResult.errorCode`/`topicFailures` (Task 4), `IngestRunRecord` (Task 3), and `drainIngest` return (Task 5). `IngestRunRecord` fields match between Task 3 definition and Task 5 construction. `appendCredentialMissingRun(cwd, triggeredBy)` signature consistent across Tasks 3/6/7.
- **No placeholders:** every code step shows complete code; test harness-matching notes flag where to mirror existing mocks rather than guessing the file's private helpers.
