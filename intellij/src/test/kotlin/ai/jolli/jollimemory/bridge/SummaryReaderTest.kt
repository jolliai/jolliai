package ai.jolli.jollimemory.bridge

import com.google.gson.Gson
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Uses [FakeGit] (a plain per-test object) instead of MockK, so this class
 * needs no isolation annotations and runs fully parallel — there is no shared
 * mutable state and no bytecode instrumentation involved. See GitCommands.kt
 * for the history behind the migration.
 */
class SummaryReaderTest {

    private val gson = Gson()
    private lateinit var git: FakeGit
    private lateinit var reader: SummaryReader

    @BeforeEach
    fun setUp() {
        git = FakeGit()
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
            git.files["summaries/abc.json"] = makeSummaryJson("abc12345", "First commit", 2)
            git.files["summaries/def.json"] = makeSummaryJson("def67890", "Second commit", 1)

            val summaries = reader.listSummaries()
            summaries shouldHaveSize 2
            summaries[0].hash shouldBe "abc12345"
            summaries[0].shortHash shouldBe "abc12345"
            summaries[0].topicCount shouldBe 2
            summaries[0].hasSummary shouldBe true
        }

        @Test
        fun `returns empty list when no summary files`() {
            reader.listSummaries().shouldBeEmpty()
        }

        @Test
        fun `skips invalid JSON files`() {
            git.files["summaries/bad.json"] = "not json"

            reader.listSummaries().shouldBeEmpty()
        }
    }

    // ── getSummary ──────────────────────────────────────────────────────

    @Nested
    inner class GetSummary {
        @Test
        fun `returns full CommitSummary when file exists`() {
            git.files["summaries/abc123.json"] = makeSummaryJson("abc123", "Test commit")

            val summary = reader.getSummary("abc123")
            summary shouldNotBe null
            summary!!.commitHash shouldBe "abc123"
        }

        @Test
        fun `returns null when file does not exist`() {
            reader.getSummary("nonexistent") shouldBe null
        }
    }

    // ── getSummaryJson ──────────────────────────────────────────────────

    @Test
    fun `getSummaryJson returns raw JSON string`() {
        val expected = """{"commitHash":"abc"}"""
        git.files["summaries/abc.json"] = expected
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
