package ai.jolli.jollimemory.core

import com.google.gson.Gson
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Path

class IngestPipelineTest {

    @TempDir
    lateinit var tempDir: Path
    private lateinit var kbRoot: Path
    private lateinit var metadataManager: MetadataManager
    private lateinit var storage: FolderStorage

    @BeforeEach
    fun setUp() {
        kbRoot = tempDir.resolve("MemoryBank").resolve("myrepo")
        metadataManager = MetadataManager(kbRoot.resolve(".jolli"))
        storage = FolderStorage(kbRoot, metadataManager)
        storage.ensure()
    }

    /** Seeds one root commit summary as a pending source. */
    private fun seedSummary() {
        val summary = CommitSummary(
            commitHash = "hash1", commitMessage = "Add auth", commitAuthor = "me",
            commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "2026-01-01T00:00:00Z",
            topics = listOf(TopicSummary(title = "Auth", trigger = "login needed", response = "added oauth", decisions = "use oauth")),
        )
        storage.writeFiles(listOf(FileWrite("summaries/hash1.json", Gson().toJson(summary))), "seed")
        metadataManager.writeIndex(
            SummaryIndex(
                entries = listOf(
                    SummaryIndexEntry(
                        commitHash = "hash1", parentCommitHash = null, commitMessage = "Add auth",
                        commitDate = "2026-01-01T00:00:00Z", branch = "main", generatedAt = "g",
                    ),
                ),
            ),
        )
    }

    private fun result(text: String, stop: String? = null) =
        LlmClient.LlmCallResult(text = text, model = "m", inputTokens = 0, outputTokens = 0, apiLatencyMs = 0, stopReason = stop)

    private val routeJson = """{"newTopics":[{"stableSlug":"my-topic","title":"My Topic","sourceIndexes":[0]}]}"""
    private val reconcileBlock =
        "===TOPIC===\n---TITLE---\nMy Topic\n---STABLESLUG---\nmy-topic\n---SUMMARY---\nSummary line\n---CONTENT---\nReconciled body\n"

    @Test
    fun `ingests a summary into a new topic page and marks it processed`() {
        seedSummary()
        var routeParams: Map<String, String>? = null
        var reconcileParams: Map<String, String>? = null
        val fake = IngestPipeline.LlmCaller { action, params, _, _ ->
            when (action) {
                "route" -> { routeParams = params; result(routeJson) }
                "reconcile" -> { reconcileParams = params; result(reconcileBlock) }
                else -> result("")
            }
        }

        val r = IngestPipeline.ingestPendingBatch(kbRoot, storage, fake, model = null, nowIso = "2026-02-02T00:00:00Z")

        r.errorCode shouldBe null
        r.ingested shouldBe 1
        r.touchedSlugs shouldContainExactly listOf("my-topic")

        // Topic page written with the reconciled content and authoritative branch.
        val page = TopicPageStore.readTopicPage("my-topic", storage)!!
        page.content shouldBe "Reconciled body"
        page.title shouldBe "My Topic"
        page.relatedBranches shouldBe listOf("main")
        page.sourceRefs.map { it.id } shouldContainExactly listOf("hash1")

        // Index + processed set updated.
        val index = TopicIndexStore.readTopicIndex(storage)
        index.topics.map { it.stableSlug } shouldContainExactly listOf("my-topic")
        index.topics[0].summary shouldBe "Summary line"
        ProcessedSourceStore.readProcessedSet(storage).processed[SourceType.SUMMARY] shouldBe listOf("hash1")

        // Param contract sent to the proxy.
        routeParams.shouldNotBeNull()
        routeParams!!.keys shouldContain "topicIndex"
        routeParams!!["sources"]!!.startsWith("[0] ") shouldBe true
        reconcileParams!!["topicTitle"] shouldBe "My Topic"
        reconcileParams!!["currentPage"] shouldBe "(new topic -- no existing page)"
        reconcileParams!!["sources"]!!.contains("Add auth") shouldBe true
    }

    @Test
    fun `route failure marks nothing processed`() {
        seedSummary()
        val fake = IngestPipeline.LlmCaller { action, _, _, _ ->
            if (action == "route") result("not valid json") else result("")
        }
        val r = IngestPipeline.ingestPendingBatch(kbRoot, storage, fake, model = null, nowIso = "t")
        r.errorCode shouldBe IngestPipeline.IngestCode.ROUTE_FAILED
        r.ingested shouldBe 0
        ProcessedSourceStore.readProcessedSet(storage).processed[SourceType.SUMMARY] shouldBe emptyList()
    }

    @Test
    fun `reconcile parse failure holds the source for retry`() {
        seedSummary()
        val fake = IngestPipeline.LlmCaller { action, _, _, _ ->
            when (action) {
                "route" -> result(routeJson)
                "reconcile" -> result("garbage with no topic block")
                else -> result("")
            }
        }
        val r = IngestPipeline.ingestPendingBatch(kbRoot, storage, fake, model = null, nowIso = "t")
        r.ingested shouldBe 0
        r.topicFailures.map { it.code } shouldContain IngestPipeline.IngestCode.RECONCILE_PARSE_FAILED
        // Source NOT marked processed → it will be retried.
        ProcessedSourceStore.readProcessedSet(storage).processed[SourceType.SUMMARY] shouldBe emptyList()
        TopicPageStore.readTopicPage("my-topic", storage) shouldBe null
    }

    @Test
    fun `defaultLlmCaller requires a Jolli sign-in (proxy-only ingest)`() {
        // Guards the bug where an Anthropic key routed to direct mode and NPE'd on the
        // null prompt. With no jolliApiKey, the caller must fail loud, not NPE.
        val caller = IngestPipeline.defaultLlmCaller(IngestPipeline.LlmConfig(apiKey = "sk-ant-xxx", jolliApiKey = null))
        val ex = org.junit.jupiter.api.assertThrows<IllegalStateException> {
            caller.call("route", mapOf("topicIndex" to "", "sources" to ""), null, null)
        }
        ex.message!!.contains("Jolli sign-in") shouldBe true
    }

    @Test
    fun `drainIngest loops to empty`() {
        seedSummary()
        val fake = IngestPipeline.LlmCaller { action, _, _, _ ->
            when (action) {
                "route" -> result(routeJson)
                "reconcile" -> result(reconcileBlock)
                else -> result("")
            }
        }
        val d = IngestPipeline.drainIngest(kbRoot, storage, fake, model = null, nowIso = "2026-02-02T00:00:00Z")
        d.ingested shouldBe 1
        d.outcome shouldBe IngestPipeline.IngestCode.OK
        // Re-draining finds nothing pending.
        val again = IngestPipeline.drainIngest(kbRoot, storage, fake, model = null, nowIso = "t")
        again.ingested shouldBe 0
    }
}
