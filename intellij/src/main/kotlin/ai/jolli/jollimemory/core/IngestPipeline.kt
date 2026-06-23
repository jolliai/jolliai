package ai.jolli.jollimemory.core

import java.nio.file.Path
import java.time.Instant
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.math.ceil
import kotlin.math.min

/**
 * IngestPipeline — folds pending sources into topic pages. One batch:
 * collect ≤N → route (1 JSON call) → reconcile each affected page (1 delimited
 * call each) → mark a source processed only if ALL its target pages succeeded.
 * [drainIngest] loops to empty. Canonical layer only; visible render is separate.
 *
 * Kotlin port of `cli/src/core/IngestPipeline.ts`. Differences from the TS:
 *  - storage + kbRoot are passed explicitly (no process-global active storage).
 *  - the LLM call is an injectable [LlmCaller] seam (tests inject a fake).
 *  - telemetry (`appendIngestRun`) is not ported.
 *  - proxy mode returns `stopReason = null`, so the `max_tokens` guards are
 *    inert there (kept for parity / direct mode).
 */
object IngestPipeline {

    private val log = JmLogger.create("IngestPipeline")

    private const val DEFAULT_BATCH_SIZE = 50
    private const val ROUTE_MAX_TOKENS = 16_384
    private const val RECONCILE_MAX_TOKENS = 64_000
    private const val RECONCILE_CONCURRENCY = 4

    /** Batch-terminal / per-topic outcome codes. */
    enum class IngestCode {
        OK, NO_PENDING, ROUTE_FAILED, RECONCILE_TRUNCATED, RECONCILE_PARSE_FAILED,
        RECONCILE_CALL_FAILED, NO_SOURCE_CONTENT, ITERATION_GUARD,
    }

    data class TopicFailure(val slug: String, val code: IngestCode)

    /** Config for the default proxy/direct LLM caller. */
    data class LlmConfig(
        val apiKey: String? = null,
        val jolliApiKey: String? = null,
        val model: String? = null,
        val aiProvider: String? = null,
    )

    /** Injectable LLM seam. The default delegates to [LlmClient.callLlm]. */
    fun interface LlmCaller {
        fun call(action: String, params: Map<String, String>, model: String?, maxTokens: Int?): LlmClient.LlmCallResult
    }

    fun defaultLlmCaller(config: LlmConfig): LlmCaller = LlmCaller { action, params, model, maxTokens ->
        // Works in BOTH modes: proxy mode uses action+params (backend owns the
        // template); direct (Anthropic) mode uses the locally-rendered `prompt`.
        // Supplying both lets the call succeed whichever credential callLlm selects,
        // so a user with only an Anthropic key can still build the wiki.
        LlmClient.callLlm(
            action = action, params = params,
            apiKey = config.apiKey, jolliApiKey = config.jolliApiKey,
            model = model, maxTokens = maxTokens,
            prompt = PromptTemplates.render(action, params),
            aiProvider = config.aiProvider,
        )
    }

    data class IngestResult(
        val ingested: Int,
        val touchedSlugs: List<String>,
        val done: Boolean,
        val pendingCount: Int,
        val reconcileCalls: Int,
        val topicFailures: List<TopicFailure>,
        val errorCode: IngestCode? = null,
    )

    data class DrainResult(
        val batches: Int,
        val ingested: Int,
        val outcome: IngestCode,
        val topicFailures: List<TopicFailure>,
    )

    private sealed interface ReconcileOutcome {
        val slug: String
        data class Ok(override val slug: String, val page: TopicPage, val indexEntry: TopicIndexEntry) : ReconcileOutcome
        data class Failed(override val slug: String, val refs: List<SourceRef>, val code: IngestCode) : ReconcileOutcome
    }

    fun ingestPendingBatch(
        kbRoot: Path,
        storage: StorageProvider,
        llm: LlmCaller,
        model: String?,
        nowIso: String = Instant.now().toString(),
        batchSize: Int = DEFAULT_BATCH_SIZE,
    ): IngestResult {
        val processed = ProcessedSourceStore.readProcessedSet(storage)
        val pending = SourceTimeline.listPendingSources(kbRoot, storage, processed)
        if (pending.isEmpty()) {
            return IngestResult(0, emptyList(), done = true, pendingCount = 0, reconcileCalls = 0, topicFailures = emptyList())
        }
        val batch = pending.take(batchSize)

        // -- Route ----------------------------------------------------------
        val index = TopicIndexStore.readTopicIndex(storage)
        val headlines = batch.map { SourceContent.loadSourceHeadline(it, kbRoot, storage) }
        val sourcesBlock = headlines.mapIndexed { i, h -> "[$i] $h" }.joinToString("\n")
        val resolvedModel = Summarizer.resolveModelId(model)
        val routeResult = llm.call(
            "route",
            mapOf("topicIndex" to formatIndexForRoute(index), "sources" to sourcesBlock),
            resolvedModel,
            ROUTE_MAX_TOKENS,
        )
        val plan = RoutePlanParser.parseRoutePlan(routeResult.text ?: "", routeResult.stopReason, batch)
        if (plan.error != null) {
            log.error("Route failed (%s) — marking nothing, will retry", plan.error)
            return IngestResult(0, emptyList(), done = false, pendingCount = pending.size, reconcileCalls = 0, topicFailures = emptyList(), errorCode = IngestCode.ROUTE_FAILED)
        }

        // -- Reconcile: parallel LLM phase (pure) ---------------------------
        val assignments = plan.assignments.entries.toList()
        val outcomes = mapWithConcurrency(
            assignments,
            RECONCILE_CONCURRENCY,
            task = { (slug, assignment) ->
                val current = if (assignment.isNew) null else TopicPageStore.readTopicPage(slug, storage)
                val title = current?.title ?: assignment.title ?: slug

                // Feed source bodies oldest → newest so reconcile applies recency-wins.
                val orderedRefs = assignment.refs.sortedWith(SourceTimeline::compareSourceRefs)
                val bodies = mutableListOf<String>()
                val foldedRefs = mutableListOf<SourceRef>()
                for (ref in orderedRefs) {
                    val body = SourceContent.loadSourceContent(ref, kbRoot, storage) ?: continue
                    bodies.add("### (${ref.type}, ${ref.timestamp})\n$body")
                    foldedRefs.add(ref)
                }
                if (bodies.isEmpty()) {
                    log.warn("Topic %s had no loadable source content — skipping", slug)
                    ReconcileOutcome.Failed(slug, assignment.refs, IngestCode.NO_SOURCE_CONTENT)
                } else {
                    val result = llm.call(
                        "reconcile",
                        mapOf(
                            "topicTitle" to title,
                            "currentPage" to (current?.content ?: "(new topic -- no existing page)"),
                            "sources" to bodies.joinToString("\n\n"),
                        ),
                        resolvedModel,
                        RECONCILE_MAX_TOKENS,
                    )
                    if (result.stopReason == "max_tokens") {
                        log.error("Reconcile truncated for topic %s — keeping old page, holding sources", slug)
                        ReconcileOutcome.Failed(slug, assignment.refs, IngestCode.RECONCILE_TRUNCATED)
                    } else {
                        val parsed = ReconciledPageParser.parseReconciledPage(result.text ?: "", slug, title)
                        if (parsed == null) {
                            log.error("Reconcile produced no topic block for %s — keeping old page, holding sources", slug)
                            ReconcileOutcome.Failed(slug, assignment.refs, IngestCode.RECONCILE_PARSE_FAILED)
                        } else {
                            val sourceRefs = mergeRefs(current?.sourceRefs ?: emptyList(), foldedRefs)
                            // relatedBranches is authoritative from contributing sources' branches,
                            // NOT the LLM's advisory echo.
                            val relatedBranches = branchesOf(sourceRefs)
                            val page = TopicPage(
                                stableSlug = slug, title = parsed.title, content = parsed.content,
                                relatedBranches = relatedBranches, sourceRefs = sourceRefs, lastUpdatedAt = nowIso,
                            )
                            val indexEntry = TopicIndexEntry(
                                stableSlug = slug, title = parsed.title, summary = parsed.summary,
                                relatedBranches = relatedBranches, sourceRefs = sourceRefs, lastUpdatedAt = nowIso,
                            )
                            ReconcileOutcome.Ok(slug, page, indexEntry)
                        }
                    }
                }
            },
            onError = { entry, err ->
                log.error("Reconcile call threw for topic %s: %s — holding sources", entry.key, err.message)
                ReconcileOutcome.Failed(entry.key, entry.value.refs, IngestCode.RECONCILE_CALL_FAILED)
            },
        )

        // -- Serial apply phase (side effects) ------------------------------
        val failedRefs = HashSet<SourceRef>()
        val touchedSlugs = mutableListOf<String>()
        val topicFailures = mutableListOf<TopicFailure>()
        var reconcileCalls = 0
        var topics = index.topics.toMutableList()
        for (outcome in outcomes) {
            val issuedCall = outcome is ReconcileOutcome.Ok || (outcome as ReconcileOutcome.Failed).code != IngestCode.NO_SOURCE_CONTENT
            if (issuedCall) reconcileCalls++
            when (outcome) {
                is ReconcileOutcome.Ok -> {
                    TopicPageStore.saveTopicPage(outcome.page, storage)
                    topics = upsertIndexEntry(topics, outcome.indexEntry)
                    touchedSlugs.add(outcome.slug)
                }
                is ReconcileOutcome.Failed -> {
                    failedRefs.addAll(outcome.refs)
                    topicFailures.add(TopicFailure(outcome.slug, outcome.code))
                }
            }
        }

        if (touchedSlugs.isNotEmpty()) {
            TopicIndexStore.saveTopicIndex(TopicIndex(schemaVersion = 1, topics = topics), storage)
        }

        // -- Mark: a source is processed iff every topic it targeted succeeded
        val routedRefs = HashSet<SourceRef>()
        for ((_, assignment) in plan.assignments) routedRefs.addAll(assignment.refs)

        val succeeded = mutableListOf<SourceRef>()
        for (ref in batch) {
            if (ref in failedRefs) continue
            if (ref !in routedRefs) log.debug("Source %s:%s routed to no topic — marking processed (un-filed)", ref.type, ref.id)
            succeeded.add(ref)
        }
        if (succeeded.isNotEmpty()) {
            ProcessedSourceStore.saveProcessedSet(ProcessedSourceStore.addProcessed(processed, succeeded), storage)
        }

        return IngestResult(
            ingested = succeeded.size,
            touchedSlugs = touchedSlugs,
            done = pending.size <= batchSize,
            pendingCount = pending.size,
            reconcileCalls = reconcileCalls,
            topicFailures = topicFailures,
        )
    }

    /** Loops [ingestPendingBatch] until empty. */
    fun drainIngest(
        kbRoot: Path,
        storage: StorageProvider,
        llm: LlmCaller,
        model: String?,
        nowIso: String = Instant.now().toString(),
        batchSize: Int = DEFAULT_BATCH_SIZE,
    ): DrainResult {
        var batches = 0
        var ingested = 0
        val touched = HashSet<String>()
        val topicFailures = mutableListOf<TopicFailure>()
        var outcome = IngestCode.OK
        var maxIterations = Int.MAX_VALUE
        while (batches < maxIterations) {
            val r = ingestPendingBatch(kbRoot, storage, llm, model, nowIso, batchSize)
            if (batches == 0) {
                maxIterations = ceil(r.pendingCount.toDouble() / batchSize).toInt() + 2
                if (r.pendingCount == 0) outcome = IngestCode.NO_PENDING
            }
            batches++
            ingested += r.ingested
            touched.addAll(r.touchedSlugs)
            topicFailures.addAll(r.topicFailures)
            if (r.errorCode != null) {
                log.error("drainIngest stopping on batch error: %s", r.errorCode)
                outcome = r.errorCode
                break
            }
            if (r.done) break
        }
        if (batches >= maxIterations) {
            log.error("drainIngest hit iteration guard (%d) — pipeline not draining, stopping", maxIterations)
            outcome = IngestCode.ITERATION_GUARD
        }
        // JOLLI-1785: pipeline-health telemetry (no-op until telemetry is bootstrapped).
        ai.jolli.jollimemory.core.telemetry.Telemetry.track(
            "ingest_completed",
            mapOf("outcome" to outcome.name, "batches" to batches, "ingested" to ingested, "topic_failures" to topicFailures.size),
        )
        if (outcome != IngestCode.OK && outcome != IngestCode.NO_PENDING) {
            ai.jolli.jollimemory.core.telemetry.Telemetry.track("error_occurred", mapOf("code" to outcome.name, "where" to "ingest"))
        }
        return DrainResult(batches, ingested, outcome, topicFailures)
    }

    // ── Helpers ────────────────────────────────────────────────────────────

    private fun formatIndexForRoute(index: TopicIndex): String {
        if (index.topics.isEmpty()) return "(none yet)"
        return index.topics.joinToString("\n") { "- ${it.stableSlug} -- ${it.title}: ${it.summary}" }
    }

    private fun upsertIndexEntry(topics: MutableList<TopicIndexEntry>, entry: TopicIndexEntry): MutableList<TopicIndexEntry> {
        val i = topics.indexOfFirst { it.stableSlug == entry.stableSlug }
        if (i == -1) topics.add(entry) else topics[i] = entry
        return topics
    }

    /** Distinct real branch names contributing to a topic, in first-seen order. */
    private fun branchesOf(refs: List<SourceRef>): List<String> =
        refs.mapNotNull { it.branch }
            .filter { it.isNotEmpty() && it != "(unknown)" && it != "unknown" }
            .distinct()

    private fun mergeRefs(prev: List<SourceRef>, add: List<SourceRef>): List<SourceRef> {
        val seen = prev.map { "${it.type}:${it.id}" }.toMutableSet()
        val out = prev.toMutableList()
        for (r in add) {
            val k = "${r.type}:${r.id}"
            if (seen.add(k)) out.add(r)
        }
        return out
    }

    /**
     * Runs [task] over [items] with bounded parallelism, preserving input order.
     * A task that throws degrades to [onError] rather than aborting the batch.
     */
    private fun <T, R> mapWithConcurrency(
        items: List<T>,
        concurrency: Int,
        task: (T) -> R,
        onError: (T, Throwable) -> R,
    ): List<R> {
        if (items.isEmpty()) return emptyList()
        val pool = Executors.newFixedThreadPool(min(concurrency, items.size)) { r ->
            Thread(r, "JolliMemory-Ingest").apply { isDaemon = true }
        }
        try {
            val futures = items.map { item ->
                pool.submit(Callable { try { task(item) } catch (e: Throwable) { onError(item, e) } })
            }
            return futures.map { it.get() }
        } finally {
            pool.shutdown()
        }
    }
}
