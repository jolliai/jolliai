package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.bridge.GitRemoteUtils
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.PushPendingReader
import ai.jolli.jollimemory.core.SummaryStore
import ai.jolli.jollimemory.core.telemetry.Telemetry
import io.kotest.matchers.shouldBe
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkObject
import io.mockk.slot
import io.mockk.unmockkAll
import io.mockk.verify
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.parallel.Isolated
import org.junit.jupiter.api.parallel.Execution
import org.junit.jupiter.api.parallel.ExecutionMode

// Temporary guard while this class still mutates JVM globals (System.setProperty/
// setOut, mockkStatic/mockkObject). Remove when migrated to HookEnv injection.
@Isolated
// MockK's recorder is JVM-global; @Nested classes are scheduled as independent
// parallel units, so intra-class concurrency corrupts stubbing too. SAME_THREAD
// is inherited by all nested classes and serializes this whole file.
@Execution(ExecutionMode.SAME_THREAD)
class JolliShareServiceTest {

    private lateinit var store: SummaryStore
    private val baseUrl = "https://acme.jolli.ai"
    private val apiKey = "sk-jol-test"

    private fun summary(orphaned: List<Int>? = null, unresolved: List<String>? = null) = CommitSummary(
        commitHash = "abc12345", commitMessage = "feat: change", commitAuthor = "Dev",
        commitDate = "t", branch = "feature/x", generatedAt = "t",
        jolliDocId = null, orphanedDocIds = orphaned,
        unresolvedOrphanHashes = unresolved,
    )

    @BeforeEach
    fun setUp() {
        store = mockk(relaxed = true)
        every { store.readPlanFromBranch(any()) } returns null // no plans in these cases

        mockkObject(JolliApiClient)
        mockkObject(GitRemoteUtils)
        mockkObject(PushPendingReader)
        mockkObject(Telemetry)
        every { GitRemoteUtils.getCanonicalRepoUrl(any()) } returns "https://github.com/o/r"
        every { GitRemoteUtils.sanitizeBranchSlug(any()) } returns "feature-x"
        every { Telemetry.track(any(), any()) } returns Unit
        every { Telemetry.bucket(any()) } returns "0"
        every { PushPendingReader.loadHashes(any()) } returns emptySet()
    }

    @AfterEach
    fun tearDown() = unmockkAll()

    @Test
    fun `pushes the summary and writes the jolli doc url back`() {
        every { JolliApiClient.pushToJolli(any(), any(), any()) } returns
            JolliApiClient.JolliPushResult(url = "ignored", docId = 99, jrn = "jrn:1", created = true)

        val res = JolliShareService.shareSummary(store, summary(), "/repo", apiKey, baseUrl)

        res.created shouldBe true
        res.planCount shouldBe 0
        res.updatedSummary.jolliDocId shouldBe 99
        res.updatedSummary.jolliDocUrl shouldBe "$baseUrl/articles?doc=99"
        // The updated summary is persisted.
        verify { store.storeSummary(match { it.jolliDocId == 99 }, force = true) }
    }

    @Test
    fun `deletes orphaned docs and clears them from the stored summary`() {
        every { JolliApiClient.pushToJolli(any(), any(), any()) } returns
            JolliApiClient.JolliPushResult(url = "ignored", docId = 5, jrn = "jrn:2", created = false)
        every { JolliApiClient.deleteFromJolli(any(), any(), any()) } returns Unit

        val res = JolliShareService.shareSummary(store, summary(orphaned = listOf(7)), "/repo", apiKey, baseUrl)

        verify { JolliApiClient.deleteFromJolli(baseUrl, apiKey, 7) }
        res.updatedSummary.orphanedDocIds shouldBe null
    }

    @Test
    fun `resolves delayed child doc ids before orphan cleanup`() {
        every { JolliApiClient.pushToJolli(any(), any(), any()) } returns
            JolliApiClient.JolliPushResult(url = "ignored", docId = 5, jrn = "jrn:2", created = false)
        every { JolliApiClient.deleteFromJolli(any(), any(), any()) } returns Unit
        every { store.getSummary("childHash") } returns summary().copy(commitHash = "childHash", jolliDocId = 77)
        every { PushPendingReader.loadHashes("/repo") } returns setOf("stillPending")

        val res = JolliShareService.shareSummary(
            store,
            summary(unresolved = listOf("childHash", "stillPending")),
            "/repo",
            apiKey,
            baseUrl,
        )

        verify { JolliApiClient.deleteFromJolli(baseUrl, apiKey, 77) }
        res.updatedSummary.unresolvedOrphanHashes shouldBe listOf("stillPending")
    }

    @Test
    fun `propagates a binding-required error to the caller`() {
        every { JolliApiClient.pushToJolli(any(), any(), any()) } throws
            JolliApiClient.BindingRequiredError(repoUrl = "https://github.com/o/r")

        val threw = try {
            JolliShareService.shareSummary(store, summary(), "/repo", apiKey, baseUrl)
            false
        } catch (_: JolliApiClient.BindingRequiredError) {
            true
        }
        threw shouldBe true
    }

    @Test
    fun `sends the summary docType payload for a summary push`() {
        val payloadSlot = slot<JolliApiClient.JolliPushPayload>()
        every { JolliApiClient.pushToJolli(any(), any(), capture(payloadSlot)) } returns
            JolliApiClient.JolliPushResult(url = "ignored", docId = 1, jrn = "jrn", created = true)

        JolliShareService.shareSummary(store, summary(), "/repo", apiKey, baseUrl)

        payloadSlot.captured.docType shouldBe "summary"
        payloadSlot.captured.commitHash shouldBe "abc12345"
    }
}
