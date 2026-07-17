/**
 * IngestPipeline — folds pending sources into topic pages. One batch:
 * collect <=N -> route (1 JSON call) -> reconcile each affected page (1 delimited
 * call each) -> mark a source processed only if ALL its target pages succeeded.
 * drainIngest loops to empty. Canonical layer only; visible render is sub-project 3.
 */

import { createLogger, errMsg } from "../Logger.js";
import { VaultWriteBusyError } from "../sync/VaultWriteLock.js";
import type { IngestOperation, LlmConfig } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { INGEST_CODES, type IngestCode } from "./IngestErrors.js";
import { appendIngestRun } from "./IngestRunStore.js";
import { callLlm, llmCredentials, llmFanoutLimit } from "./LlmClient.js";
import { addProcessed, readProcessedSet, saveProcessedSet } from "./ProcessedSourceStore.js";
import { createReadStorage } from "./ReadStorageResolver.js";
import { parseReconciledPage } from "./ReconciledPage.js";
import { parseRoutePlan } from "./RoutePlan.js";
import { loadSourceContent, loadSourceHeadline } from "./SourceContent.js";
import { compareSourceRefs, listPendingSources } from "./SourceTimeline.js";
import type { StorageProvider } from "./StorageProvider.js";
import { resolveModelId } from "./Summarizer.js";
import { readTopicIndex, saveTopicIndex } from "./TopicIndexStore.js";
import type { SourceRef, TopicIndex, TopicIndexEntry, TopicPage } from "./TopicKBTypes.js";
import { readTopicPage, saveTopicPage } from "./TopicPageStore.js";

const log = createLogger("IngestPipeline");

/**
 * The Web-standard AbortError. Callers detect cancel with `err.name ===
 * "AbortError"` so this matches what `fetch(..., { signal })` throws — no
 * bespoke error class the outer layers would need to import.
 */
function abortError(): DOMException {
	return new DOMException("Ingest cancelled", "AbortError");
}

const DEFAULT_BATCH_SIZE = 50;
// The route call can run long, so it takes LlmClient's streaming path (no fixed
// 180s direct-call cap, just the idle + wall-clock watchdogs). We request it
// explicitly via `forceStreaming` rather than coercing it by padding maxTokens
// above the streaming threshold — an explicit flag can't be silently undone by
// retuning the threshold or this token count.
const ROUTE_MAX_TOKENS = 16_384;
const RECONCILE_MAX_TOKENS = 64_000;
const RECONCILE_CONCURRENCY = 4; // fan out reconcile LLM calls; writes stay serial

/**
 * Per-batch progress tick. Every field carries a real value on every tick — no
 * field is ever a placeholder the consumer must second-guess which to trust.
 * Two ticks fire per batch: a PRE-ROUTE tick right before the route LLM call
 * (`topicsInBatch` absent — the plan isn't known yet) and a POST-ROUTE tick once
 * route returns (`topicsInBatch` present). `drainIngest` then fires ONE terminal
 * tick after the loop so a UI can move from "batch N running" to a final state.
 * `pendingCount` is the pre-slice snapshot for THIS batch (0 on the terminal
 * tick — nothing further is in flight); `ingestedSoFar` is the drain-wide running
 * total at the moment of the tick.
 */
export interface BatchProgress {
	readonly batchIndex: number; // 1-based
	readonly pendingCount: number;
	readonly ingestedSoFar: number;
	/**
	 * Count of topics being reconciled in THIS batch, known only once route has
	 * returned. Present on the post-route tick; absent on the pre-route tick
	 * (before the plan exists) and on the terminal tick. Consumers use it
	 * alongside `TopicProgress.done` to render "N of M topics" bars.
	 */
	readonly topicsInBatch?: number;
}

/**
 * Fine-grained per-topic progress within a single batch's reconcile fan-out.
 * Fires immediately after each reconcile LLM call returns — successful or
 * held. UIs can show "reconciled 5 of 12 in batch 3" without polling.
 */
export interface TopicProgress {
	readonly batchIndex: number; // 1-based, same as BatchProgress.batchIndex
	/** How many topics finished so far in this batch (1..N). */
	readonly done: number;
	/** How many topics total in this batch. */
	readonly of: number;
	/** The slug that just finished. */
	readonly slug: string;
	/** Outcome discriminant so a UI can color-code held topics. */
	readonly outcome: "ok" | "held";
}

export interface IngestOptions {
	readonly batchSize?: number;
	readonly nowIso?: string; // injectable timestamp (tests / determinism)
	/**
	 * Read-side storage for source collection (summary index, plan/note, userfiles).
	 * Supplied by the multi-repo sweep so it can target a repo folder that has no
	 * git working tree. When absent, resolved from `cwd` via createReadStorage.
	 */
	readonly readStorage?: StorageProvider;
	/** Tags the telemetry record written by drainIngest. Defaults to "manual". */
	readonly triggeredBy?: IngestOperation["triggeredBy"];
	/**
	 * Wraps each persistence call (topic-page / index / processed-set write) so the
	 * caller can serialise it under a lock and release between writes. The LLM
	 * route + reconcile phase runs OUTSIDE this guard. ALL production callers — the
	 * `jolli compile` paths (`compileSingleRepo` / `compileAllRepos`) AND the
	 * QueueWorker post-commit path — pass a guard that acquires `vault-write.lock`
	 * PER WRITE (releasing between writes) so a long ingest never blocks
	 * commit-summary generation, throwing `VaultWriteBusyError` on a busy miss (see
	 * `cli/src/sync/VaultWriteLock.ts`). Defaults to identity for unit tests only.
	 */
	readonly writeGuard?: (fn: () => Promise<void>) => Promise<void>;
	/**
	 * Cooperative cancellation. Checked between batches (an abort between batches
	 * never pays for another route+reconcile call) AND forwarded into the route
	 * and reconcile `callLlm` calls, so an in-flight LLM request is torn down
	 * promptly instead of running out its own per-request timeout. Reconcile writes
	 * happen strictly after the LLM fan-out resolves, so a cancelled reconcile
	 * leaves no partial write — its sources are simply held for the next drain.
	 * Throws a DOMException of name `AbortError` when triggered mid-drain; a signal
	 * aborted before the first batch throws before any work starts.
	 */
	readonly signal?: AbortSignal;
	/**
	 * Per-batch progress emitter. Fires twice per batch — a pre-route tick right
	 * before the route LLM call and a post-route tick once the plan is known (see
	 * BatchProgress) — then ONCE MORE at drain end (after the loop exits) so a UI
	 * can transition from "batch N running" to a final state. Every tick carries
	 * all BatchProgress fields with real values. Errors thrown by the callback are
	 * logged and swallowed — progress display MUST NOT be able to fail a compile.
	 */
	readonly onBatch?: (progress: BatchProgress) => void;
	/**
	 * Per-topic progress callback fired within a batch as each reconcile LLM
	 * call finishes. Called `topicsInBatch` times per batch (or not at all
	 * when route returns nothing). Errors thrown by the callback are logged
	 * and swallowed — progress display MUST NOT be able to fail a compile.
	 * Absent by default; hosts that don't need per-source granularity omit it.
	 */
	readonly onTopic?: (progress: TopicProgress) => void;
	/**
	 * Internal seam: `drainIngest` sets this on each call to `ingestPendingBatch`
	 * so `onTopic` events carry the correct batch index. Callers of
	 * `ingestPendingBatch` directly can leave it as 1 (or unset); it never
	 * affects control flow, only the value threaded into `onTopic`.
	 */
	readonly currentBatchIndex?: number;
	/**
	 * Internal seam: `drainIngest` sets this to its running ingested total so the
	 * `onBatch` ticks emitted here carry the correct drain-wide `ingestedSoFar`.
	 * Direct callers of `ingestPendingBatch` leave it 0; it only affects the value
	 * threaded into `onBatch`, never control flow.
	 */
	readonly ingestedSoFar?: number;
}

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

export async function ingestPendingBatch(cwd: string, config: LlmConfig, opts?: IngestOptions): Promise<IngestResult> {
	const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
	const nowIso = opts?.nowIso ?? new Date().toISOString();
	// readStorage is the *read* view (folder in dual-write, matching the VSCode UI);
	// EVERY read below — pending sources, processed set, topic index, source bodies,
	// and the current page in reconcile — must go through it so route and reconcile
	// see one snapshot. Writes (saveTopicPage/Index/ProcessedSet) deliberately omit it
	// so they keep going through the active DualWriteStorage (both layers).
	const readStorage = opts?.readStorage ?? (await createReadStorage(cwd));

	const processed = await readProcessedSet(cwd, readStorage);
	const pending = await listPendingSources(cwd, processed, readStorage);
	if (pending.length === 0)
		return { ingested: 0, touchedSlugs: [], done: true, pendingCount: 0, reconcileCalls: 0, topicFailures: [] };

	const batch = pending.slice(0, batchSize);
	const currentBatchIndex = opts?.currentBatchIndex ?? 1;
	const ingestedSoFar = opts?.ingestedSoFar ?? 0;
	// Progress emitter: wrapped so a throwing callback can never sink the batch.
	// Every tick carries all BatchProgress fields with real values.
	const emitBatch = (progress: BatchProgress): void => {
		try {
			opts?.onBatch?.(progress);
		} catch (e) {
			log.warn("onBatch threw (ignored): %s", e instanceof Error ? e.message : String(e));
		}
	};
	// Pre-route tick: pendingCount is the real pre-slice snapshot; topicsInBatch is
	// unknown until route returns. Fires immediately before the route LLM call so a
	// UI shows "batch N starting" while the call is in flight.
	emitBatch({ batchIndex: currentBatchIndex, pendingCount: pending.length, ingestedSoFar });

	// -- Route -----------------------------------------------------------------
	const index = await readTopicIndex(cwd, readStorage);
	const headlines = await Promise.all(batch.map((r) => loadSourceHeadline(r, cwd, readStorage)));
	const sourcesBlock = headlines.map((h, i) => `[${i}] ${h}`).join("\n");
	const routeResult = await callLlm({
		action: "route",
		params: { topicIndex: formatIndexForRoute(index), sources: sourcesBlock },
		model: resolveModelId(config.model),
		maxTokens: ROUTE_MAX_TOKENS,
		forceStreaming: true,
		...llmCredentials(config),
		// Forward the caller signal so an in-flight route call is torn down on abort
		// rather than running out its own timeout. Nothing is written before route
		// completes, so a cancelled route leaves no partial state.
		signal: opts?.signal,
	});
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

	// -- Reconcile: parallel LLM phase (pure) -> serial apply phase (writes) ---
	type ReconcileOutcome =
		// `before` is the page snapshot read pre-LLM (null for a new topic); the guarded
		// write compares it against a fresh read to detect a concurrent rewrite (RMW).
		| {
				kind: "ok";
				slug: string;
				page: TopicPage;
				indexEntry: TopicIndexEntry;
				before: TopicPage | null;
				refs: readonly SourceRef[];
		  }
		| { kind: "failed"; slug: string; refs: SourceRef[]; code: IngestCode };

	const assignments = [...plan.assignments];
	const topicsInBatch = assignments.length;
	// Post-route tick: same running totals as the pre-route tick, now carrying
	// `topicsInBatch` so a UI can size its "N of M topics" bar as soon as route
	// returns. `TopicProgress.done` follows as each reconcile finishes.
	emitBatch({ batchIndex: currentBatchIndex, pendingCount: pending.length, ingestedSoFar, topicsInBatch });
	let topicsDone = 0;
	const emitTopic = (slug: string, outcome: "ok" | "held") => {
		topicsDone++;
		try {
			opts?.onTopic?.({
				batchIndex: currentBatchIndex,
				done: topicsDone,
				of: topicsInBatch,
				slug,
				outcome,
			});
		} catch (e) {
			log.warn("onTopic threw (ignored): %s", e instanceof Error ? e.message : String(e));
		}
	};
	const outcomes = await mapWithConcurrency<[string, (typeof assignments)[number][1]], ReconcileOutcome>(
		assignments,
		llmFanoutLimit(RECONCILE_CONCURRENCY, config),
		async ([slug, assignment]) => {
			const current = assignment.isNew ? null : await readTopicPage(slug, cwd, readStorage);
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
				...llmCredentials(config),
				// Safe to forward: the reconcile phase is pure — every write happens
				// strictly AFTER this fan-out resolves — so a cancelled call leaves no
				// partial write, only sources held for the next drain.
				signal: opts?.signal,
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
			return { kind: "ok", slug, page, indexEntry, before: current, refs: assignment.refs };
		},
		// A task that throws (the reconcile LLM call failed — network/abort/transport/
		// unexpected) degrades to a held CALL failure rather than aborting the whole
		// batch. Distinct from RECONCILE_PARSE_FAILED (the call returned but its
		// text didn't parse): mislabeling a transient transport error as a
		// deterministic content problem hides the real failure class in telemetry.
		([slug, assignment], err) => {
			// A cancelled drain tears down every in-flight reconcile call at once —
			// those are cancellations, not reconcile faults, so log them quietly. The
			// returned CALL-failure code is never persisted on cancel: the post-loop
			// signal check in drainIngest aborts before appendIngestRun.
			if (opts?.signal?.aborted) {
				log.debug("Reconcile call cancelled for topic %s -- holding sources", slug);
			} else {
				log.error("Reconcile call threw for topic %s: %s -- holding sources", slug, (err as Error).message);
			}
			return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.RECONCILE_CALL_FAILED };
		},
		// Per-topic progress fires the moment each reconcile resolves (ok or held),
		// so UIs render "N of M topics" in near-real-time instead of waiting for
		// the whole batch's LLM phase to finish.
		(outcome) => emitTopic(outcome.slug, outcome.kind === "ok" ? "ok" : "held"),
	);

	// -- Classify outcomes (pure, lock-free) -----------------------------------
	const failedRefs = new Set<SourceRef>();
	const okOutcomes: Array<{
		slug: string;
		page: TopicPage;
		indexEntry: TopicIndexEntry;
		before: TopicPage | null;
		refs: readonly SourceRef[];
	}> = [];
	const topicFailures: { slug: string; code: IngestCode }[] = [];
	let reconcileCalls = 0;
	for (const outcome of outcomes) {
		// `ok` always issued a reconcile LLM call; a `failed` issued one unless it
		// short-circuited on NO_SOURCE_CONTENT (which never reached callLlm).
		// `outcome.code` only exists on the `failed` variant, so guard via the discriminant.
		const issuedCall = outcome.kind === "ok" || outcome.code !== INGEST_CODES.NO_SOURCE_CONTENT;
		if (issuedCall) reconcileCalls++;
		if (outcome.kind === "ok") {
			okOutcomes.push({
				slug: outcome.slug,
				page: outcome.page,
				indexEntry: outcome.indexEntry,
				before: outcome.before,
				refs: outcome.refs,
			});
		} else {
			for (const ref of outcome.refs) failedRefs.add(ref);
			topicFailures.push({ slug: outcome.slug, code: outcome.code });
		}
	}
	// -- Guarded write phase ---------------------------------------------------
	// `writeGuard` is the seam where every production caller (QueueWorker AND the
	// `jolli compile` paths) hangs the per-write `vault-write.lock` (acquire →
	// write → release) so a long ingest never holds the lock across the reconcile
	// LLM phase and never blocks commit-summary generation. Default is identity for
	// unit tests only.
	//
	// Optimistic concurrency: between the lock-free reconcile read and this guarded
	// write a sync pull (or a concurrent drain) may have rewritten the page. We
	// re-read it INSIDE the guard and compare to the `before` snapshot reconcile
	// used; on divergence the reconciled body is stale, so we HOLD the source (skip
	// the write) instead of clobbering the newer content. A writeGuard throw (lock
	// not acquired in budget) is treated identically — hold this page, keep going.
	// Both land as PAGE_WRITE_CONFLICT and feed `failedRefs`.
	//
	// Each page is persisted ATOMICALLY with its index entry, inside ONE guarded
	// section. A separate index write (an independent later lock acquisition) could
	// fail to acquire the lock AFTER the page persisted, orphaning the page — on
	// disk but absent from the index — which the next drain re-routes as a brand-new
	// topic, whose guarded re-read then finds the orphan page and holds the source
	// forever (recoverable only by `--rebuild`). The index is re-read FRESH inside
	// the guard (RMW) so a concurrent index change is merged, not clobbered. The
	// processed-set is written last (also a fresh-read RMW) once every targeted page
	// has persisted.
	const writeGuard = opts?.writeGuard ?? ((fn: () => Promise<void>) => fn());
	const written: typeof okOutcomes = [];
	for (const o of okOutcomes) {
		let held = false;
		// Default to the benign conflict code; a real (non-busy) write fault below
		// overrides it with PAGE_WRITE_ERROR so it isn't masked as contention.
		let heldCode: IngestCode = INGEST_CODES.PAGE_WRITE_CONFLICT;
		try {
			await writeGuard(async () => {
				const live = await readTopicPage(o.slug, cwd, readStorage);
				if (!samePage(live, o.before)) {
					log.warn(
						"Topic %s changed under us during the lock-free LLM phase -- holding sources, not clobbering",
						o.slug,
					);
					held = true;
					return;
				}
				await saveTopicPage(o.page, cwd);
				// Same guarded section as the page write: a page never lands without
				// its index entry. RMW onto a fresh index read so a concurrent index
				// change (sync pull / another drain) is preserved, not clobbered.
				const freshIndex = await readTopicIndex(cwd, readStorage);
				const mergedIndex: TopicIndex = { schemaVersion: 1, topics: [...freshIndex.topics] };
				upsertIndexEntry(mergedIndex, o.indexEntry);
				await saveTopicIndex(mergedIndex, cwd);
			});
		} catch (e) {
			held = true;
			if (e instanceof VaultWriteBusyError) {
				// Lock busy in budget — benign, retried next drain (PAGE_WRITE_CONFLICT).
				log.warn("Topic %s page write could not acquire vault-write.lock in budget -- holding sources", o.slug);
			} else {
				// A real I/O / serialisation / plumbing fault, NOT lock contention. Hold
				// the source so the batch continues, but surface it as an ERROR (not a
				// benign conflict) so it isn't silently retried forever and unflagged.
				heldCode = INGEST_CODES.PAGE_WRITE_ERROR;
				log.error("Topic %s page write FAILED (not lock contention) -- holding sources: %s", o.slug, errMsg(e));
			}
		}
		if (held) {
			for (const ref of o.refs) failedRefs.add(ref);
			topicFailures.push({ slug: o.slug, code: heldCode });
		} else {
			written.push(o);
		}
	}
	const touchedSlugs = written.map((o) => o.slug);

	// -- Mark set: a source is processed iff every topic it targeted succeeded -
	// A failed (or held) page adds ALL its assigned refs to `failedRefs`, so a source
	// that targeted any such page is held back; a source routed nowhere is simply done.
	// Computed AFTER the page writes so page-write conflicts are reflected here too.
	const routedRefs = new Set<SourceRef>();
	for (const [, assignment] of plan.assignments) for (const ref of assignment.refs) routedRefs.add(ref);
	const succeeded: SourceRef[] = [];
	for (const ref of batch) {
		if (failedRefs.has(ref)) continue;
		if (!routedRefs.has(ref)) {
			log.debug("Source %s:%s routed to no topic -- marking processed (un-filed)", ref.type, ref.id);
		}
		succeeded.push(ref); // either fully routed-and-reconciled, or routed nowhere (un-filed) -- both are "done"
	}

	// Processed-set: its own guarded RMW, AFTER every page+index write. A guard
	// failure here is hold-and-continue (NOT a batch abort): the sources stay
	// pending and are retried next drain. Because each page was written atomically
	// with its index entry above, that retry takes the UPDATE path (topic already
	// indexed), the unchanged re-read passes, and the write self-heals — so a missed
	// processed-set write never strands a source the way a missed index write would.
	if (succeeded.length > 0) {
		try {
			await writeGuard(async () => {
				const fresh = await readProcessedSet(cwd, readStorage);
				await saveProcessedSet(addProcessed(fresh, succeeded), cwd);
			});
		} catch (e) {
			log.error(
				"Processed-set write could not acquire the write lock -- %d source(s) stay pending for the next drain: %s",
				succeeded.length,
				(e as Error).message,
			);
		}
	}

	return {
		ingested: succeeded.length,
		touchedSlugs,
		done: pending.length <= batchSize,
		pendingCount: pending.length,
		reconcileCalls,
		topicFailures,
	};
}

/** Loops ingestPendingBatch until empty, then records one telemetry run. */
export async function drainIngest(
	cwd: string,
	config: LlmConfig,
	opts?: IngestOptions,
): Promise<{
	batches: number;
	ingested: number;
	outcome: IngestCode;
	topicFailures: { slug: string; code: IngestCode }[];
}> {
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
	// A pre-drain aborted signal short-circuits without any batch work — matches
	// the "no side-effects on cancelled call" contract callers expect.
	if (opts?.signal?.aborted) throw abortError();
	while (batches < maxIterations) {
		// Signal check runs at the loop head so an abort BETWEEN batches never
		// pays for another route+reconcile call. Inside a batch we don't
		// interrupt — the LLM call has its own timeout and its writes are
		// guarded, so letting a batch complete is safer than yanking mid-write.
		if (opts?.signal?.aborted) throw abortError();
		// Thread the running batch index + ingested total into ingestPendingBatch so
		// the onBatch ticks it emits (pre-route + post-route) carry the right batch
		// number and drain-wide `ingestedSoFar` without a global. The "batch N
		// starting" tick now fires INSIDE ingestPendingBatch — once the real pending
		// count is known — instead of here with a placeholder count.
		const r = await ingestPendingBatch(cwd, config, {
			...opts,
			currentBatchIndex: batches + 1,
			ingestedSoFar: ingested,
		});
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
		// No forward progress this batch: every targeted page was held (sustained
		// vault-write.lock contention, a real write fault, or a deterministic
		// reconcile failure). `ingested === 0` means no source was marked processed,
		// so the next batch would re-route the IDENTICAL pending slice — re-billing
		// the route + reconcile LLM phase for zero gain. Stop and let the next
		// trigger (post-commit re-enqueue / successor worker / user re-run) retry.
		// The iteration guard below remains a backstop for the pathological case
		// where each batch DOES make progress yet never drains.
		if (r.ingested === 0) {
			// `ingested === 0` means every batched ref landed in `failedRefs`, and both
			// sites that add to `failedRefs` (reconcile-failure + page-write-hold) push a
			// matching `topicFailures` entry in lockstep — so `topicFailures[0]` is always
			// present here. Read its code directly: a `?? PAGE_WRITE_CONFLICT` fallback
			// would be unreachable dead code (the array is never empty when ingested === 0).
			outcome = r.topicFailures[0].code;
			log.warn(
				"drainIngest made no progress this batch (%d source(s) held, outcome=%s) -- stopping; next trigger retries",
				r.pendingCount,
				outcome,
			);
			break;
		}
	}
	if (batches >= maxIterations) {
		log.error("drainIngest hit iteration guard (%d) -- pipeline not draining, stopping", maxIterations);
		outcome = INGEST_CODES.ITERATION_GUARD;
	}

	// A drain cancelled DURING a batch reaches here via the no-progress / done
	// break rather than the loop-head abort check: the reconcile fan-out converts
	// each aborted call to a held CALL failure (it never throws), so the batch
	// returns ingested===0 instead of propagating the cancel. Re-check the signal
	// before the terminal tick + appendIngestRun so a cancel throws (and is caught
	// by the caller's isAbortError check as "cancelled") instead of persisting a
	// misleading RECONCILE_CALL_FAILED ingest-run. Matches the loop-head checks.
	//
	// This is NOT a full "cancel writes nothing" rollback (only the PRE-drain
	// check at the top is): reconciles that RESOLVED before the cancel arrived
	// were already persisted by the batch's write phase — atomically, page+index
	// together — and their sources marked processed. That is deliberate and
	// progress-preserving: completed LLM work is kept, only in-flight calls are
	// held and the telemetry run is skipped. So "no side-effects on cancel" holds
	// for a pre-drain abort; a mid-drain cancel keeps whatever already finished.
	if (opts?.signal?.aborted) throw abortError();

	// Terminal onBatch tick: the loop is done (drained, error-stopped, or
	// guard-tripped). One final tick lets a UI move from "batch N running" to a
	// final state. `pendingCount: 0` marks "nothing further in flight";
	// `ingestedSoFar` is the drain-wide total. Wrapped like the per-batch ticks so
	// a throwing callback can't fail the run.
	try {
		opts?.onBatch?.({ batchIndex: batches, pendingCount: 0, ingestedSoFar: ingested });
	} catch (e) {
		log.warn("onBatch threw (ignored): %s", e instanceof Error ? e.message : String(e));
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

function formatIndexForRoute(index: TopicIndex): string {
	if (index.topics.length === 0) return "(none yet)";
	return index.topics.map((t) => `- ${t.stableSlug} -- ${t.title}: ${t.summary}`).join("\n");
}

/**
 * Optimistic-concurrency check for the guarded page write: did the on-disk page
 * change since reconcile read it? `lastUpdatedAt` is bumped on every reconcile so
 * it alone flags a concurrent writer; `content` is compared too as a belt-and-braces
 * guard. Both `null`/absent (a new topic still absent) counts as unchanged. A
 * new topic that now exists, or an existing page whose body or timestamp moved,
 * counts as changed. Under the identity writeGuard (unit tests only) nothing can
 * change between read and write, so this is always `true` there; under the real
 * per-write guard every production caller now passes, a concurrent commit-summary
 * worker or sync pull CAN move the page, so this legitimately returns `false`.
 */
function samePage(a: TopicPage | null | undefined, b: TopicPage | null | undefined): boolean {
	const aAbsent = a == null;
	const bAbsent = b == null;
	if (aAbsent || bAbsent) return aAbsent && bAbsent;
	return a.lastUpdatedAt === b.lastUpdatedAt && a.content === b.content;
}

function upsertIndexEntry(index: TopicIndex, entry: TopicIndexEntry): void {
	const i = index.topics.findIndex((t) => t.stableSlug === entry.stableSlug);
	if (i === -1) index.topics.push(entry);
	else index.topics[i] = entry;
}

function unique(xs: ReadonlyArray<string>): string[] {
	return [...new Set(xs)];
}

/** Distinct, real branch names contributing to a topic, in first-seen order.
 *  Drops unset branches (userfiles, legacy refs) and the LLM's "(unknown)" sentinels. */
function branchesOf(refs: ReadonlyArray<SourceRef>): string[] {
	return unique(refs.map((r) => r.branch ?? "").filter((b) => b.length > 0 && b !== "(unknown)" && b !== "unknown"));
}

function mergeRefs(prev: ReadonlyArray<SourceRef>, add: ReadonlyArray<SourceRef>): SourceRef[] {
	const seen = new Set(prev.map((r) => `${r.type}:${r.id}`));
	const out = [...prev];
	for (const r of add) {
		const k = `${r.type}:${r.id}`;
		if (!seen.has(k)) {
			seen.add(k);
			out.push(r);
		}
	}
	return out;
}
