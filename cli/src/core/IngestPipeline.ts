/**
 * IngestPipeline — folds pending sources into topic pages. One batch:
 * collect <=N -> route (1 JSON call) -> reconcile each affected page (1 delimited
 * call each) -> mark a source processed only if ALL its target pages succeeded.
 * drainIngest loops to empty. Canonical layer only; visible render is sub-project 3.
 */

import { createLogger } from "../Logger.js";
import type { IngestOperation, LlmConfig } from "../Types.js";
import { mapWithConcurrency } from "./Concurrency.js";
import { INGEST_CODES, type IngestCode } from "./IngestErrors.js";
import { appendIngestRun } from "./IngestRunStore.js";
import { callLlm } from "./LlmClient.js";
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

const DEFAULT_BATCH_SIZE = 50;
// The route call can run long, so it takes LlmClient's streaming path (no fixed
// 180s direct-call cap, just the idle + wall-clock watchdogs). We request it
// explicitly via `forceStreaming` rather than coercing it by padding maxTokens
// above the streaming threshold — an explicit flag can't be silently undone by
// retuning the threshold or this token count.
const ROUTE_MAX_TOKENS = 16_384;
const RECONCILE_MAX_TOKENS = 64_000;
const RECONCILE_CONCURRENCY = 4; // fan out reconcile LLM calls; writes stay serial

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
		apiKey: config.apiKey,
		jolliApiKey: config.jolliApiKey,
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
		| { kind: "ok"; slug: string; page: TopicPage; indexEntry: TopicIndexEntry }
		| { kind: "failed"; slug: string; refs: SourceRef[]; code: IngestCode };

	const assignments = [...plan.assignments];
	const outcomes = await mapWithConcurrency<[string, (typeof assignments)[number][1]], ReconcileOutcome>(
		assignments,
		RECONCILE_CONCURRENCY,
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
		// A task that throws (the reconcile LLM call failed — network/abort/transport/
		// unexpected) degrades to a held CALL failure rather than aborting the whole
		// batch. Distinct from RECONCILE_PARSE_FAILED (the call returned but its
		// text didn't parse): mislabeling a transient transport error as a
		// deterministic content problem hides the real failure class in telemetry.
		([slug, assignment], err) => {
			log.error("Reconcile call threw for topic %s: %s -- holding sources", slug, (err as Error).message);
			return { kind: "failed", slug, refs: [...assignment.refs], code: INGEST_CODES.RECONCILE_CALL_FAILED };
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

	// -- Mark: a source is processed iff every topic it targeted succeeded -----
	// A failed page adds ALL its assigned refs to `failedRefs`, so a source that
	// targeted any failed page is held back; a source routed nowhere is simply done.
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
	if (succeeded.length > 0) await saveProcessedSet(addProcessed(processed, succeeded), cwd);

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

function formatIndexForRoute(index: TopicIndex): string {
	if (index.topics.length === 0) return "(none yet)";
	return index.topics.map((t) => `- ${t.stableSlug} -- ${t.title}: ${t.summary}`).join("\n");
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
