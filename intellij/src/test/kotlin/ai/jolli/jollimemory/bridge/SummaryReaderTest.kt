package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CommitSummary
import com.google.gson.Gson
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryReaderTest {

    private val gson = Gson()
    private lateinit var git: GitOps
    private lateinit var reader: SummaryReader

    @BeforeEach
    fun setUp() {
        git = mockk(relaxed = true)
        reader = SummaryReader("/fake/project", git)
    }

    private fun makeSummaryJson(hash: String, message: String, topicCount: Int = 1): String {
        val topics = (1..topicCount).map {
            mapOf(
                "title" to "Topic $it",
                "trigger" to "trigger",
                "response" to "response",
                "decisions" to "decisions",
            )
        }
        return gson.toJson(
            mapOf(
                "commitHash" to hash,
                "commitMessage" to message,
                "commitAuthor" to "Alice",
                "commitDate" to "2026-01-15T10:00:00Z",
                "branch" to "main",
                "generatedAt" to "2026-01-15T10:00:00Z",
                "topics" to topics,
            ),
        )
    }

    // ── listSummaries ───────────────────────────────────────────────────

    @Nested
    inner class ListSummaries {
        @Test
        fun `returns parsed summaries sorted by date`() {
            every { git.listBranchFiles(any(), "summaries/") } returns listOf("summaries/abc.json", "summaries/def.json")
            every { git.readBranchFile(any(), "summaries/abc.json") } returns makeSummaryJson("abc12345", "First commit", 2)
            every { git.readBranchFile(any(), "summaries/def.json") } returns makeSummaryJson("def67890", "Second commit", 1)

            val summaries = reader.listSummaries()
            summaries shouldHaveSize 2
            summaries[0].hash shouldBe "abc12345"
            summaries[0].shortHash shouldBe "abc12345"
            summaries[0].topicCount shouldBe 2
            summaries[0].hasSummary shouldBe true
        }

        @Test
        fun `returns empty list when no summary files`() {
            every { git.listBranchFiles(any(), "summaries/") } returns emptyList()
            reader.listSummaries().shouldBeEmpty()
        }

        @Test
        fun `skips invalid JSON files`() {
            every { git.listBranchFiles(any(), "summaries/") } returns listOf("summaries/bad.json")
            every { git.readBranchFile(any(), "summaries/bad.json") } returns "not json"

            reader.listSummaries().shouldBeEmpty()
        }
    }

    // ── getSummary ──────────────────────────────────────────────────────

    @Nested
    inner class GetSummary {
        @Test
        fun `returns full CommitSummary when file exists`() {
            val json = makeSummaryJson("abc123", "Test commit")
            every { git.readBranchFile(any(), "summaries/abc123.json") } returns json

            val summary = reader.getSummary("abc123")
            summary shouldNotBe null
            summary!!.commitHash shouldBe "abc123"
        }

        @Test
        fun `returns null when file does not exist`() {
            every { git.readBranchFile(any(), any()) } returns null
            reader.getSummary("nonexistent") shouldBe null
        }
    }

    // ── getSummaryJson ──────────────────────────────────────────────────

    @Test
    fun `getSummaryJson returns raw JSON string`() {
        val expected = """{"commitHash":"abc"}"""
        every { git.readBranchFile(any(), "summaries/abc.json") } returns expected
        reader.getSummaryJson("abc") shouldBe expected
    }

    // ── CommitSummaryBrief ──────────────────────────────────────────────

    @Test
    fun `CommitSummaryBrief has correct defaults`() {
        val brief = CommitSummaryBrief(
            hash = "abc",
            shortHash = "abc",
            message = "msg",
            author = "Author",
            date = "2026-01-01",
        )
        brief.authorEmail shouldBe ""
        brief.shortDate shouldBe ""
        brief.topicCount shouldBe 0
        brief.insertions shouldBe 0
        brief.deletions shouldBe 0
        brief.filesChanged shouldBe 0
        brief.isPushed shouldBe false
        brief.hasSummary shouldBe false
        brief.commitType shouldBe null
    }
}
