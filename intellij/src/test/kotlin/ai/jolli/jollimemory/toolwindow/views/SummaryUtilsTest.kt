package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicCategory
import ai.jolli.jollimemory.core.TopicImportance
import ai.jolli.jollimemory.core.TopicSummary
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryUtilsTest {

    // ── escHtml ─────────────────────────────────────────────────────────

    @Nested
    inner class EscHtml {
        @Test
        fun `escapes ampersand`() {
            SummaryUtils.escHtml("a&b") shouldBe "a&amp;b"
        }

        @Test
        fun `escapes angle brackets`() {
            SummaryUtils.escHtml("<script>") shouldBe "&lt;script&gt;"
        }

        @Test
        fun `escapes quotes`() {
            SummaryUtils.escHtml("""say "hi"""") shouldBe "say &quot;hi&quot;"
        }

        @Test
        fun `returns empty string unchanged`() {
            SummaryUtils.escHtml("") shouldBe ""
        }
    }

    // ── escAttr ─────────────────────────────────────────────────────────

    @Nested
    inner class EscAttr {
        @Test
        fun `escapes single quotes`() {
            SummaryUtils.escAttr("it's") shouldContain "&#39;"
        }

        @Test
        fun `escapes all special characters`() {
            val result = SummaryUtils.escAttr("""<a href="test" class='x'>&""")
            result shouldNotContain "<"
            result shouldNotContain ">"
            result shouldNotContain "\""
            result shouldNotContain "'"
        }
    }

    // ── formatDate ──────────────────────────────────────────────────────

    @Nested
    inner class FormatDate {
        @Test
        fun `formats ISO date to readable format`() {
            val result = SummaryUtils.formatDate("2026-01-15T10:30:00Z")
            result shouldContain "Jan"
            result shouldContain "2026"
        }

        @Test
        fun `returns original string for invalid date`() {
            SummaryUtils.formatDate("not a date") shouldBe "not a date"
        }
    }

    // ── formatFullDate ──────────────────────────────────────────────────

    @Nested
    inner class FormatFullDate {
        @Test
        fun `formats ISO date to full format`() {
            val result = SummaryUtils.formatFullDate("2026-01-15T10:30:00Z")
            result shouldContain "January"
            result shouldContain "2026"
        }

        @Test
        fun `returns original string for invalid date`() {
            SummaryUtils.formatFullDate("bad") shouldBe "bad"
        }
    }

    // ── timeAgo ─────────────────────────────────────────────────────────

    @Nested
    inner class TimeAgo {
        @Test
        fun `returns Just now for very recent time`() {
            val now = java.time.Instant.now().toString()
            SummaryUtils.timeAgo(now) shouldBe "Just now"
        }

        @Test
        fun `returns original string for invalid date`() {
            SummaryUtils.timeAgo("invalid") shouldBe "invalid"
        }
    }

    // ── dayOnly ─────────────────────────────────────────────────────────

    @Test
    fun `dayOnly extracts date portion`() {
        SummaryUtils.dayOnly("2026-01-15T10:30:00Z") shouldBe "2026-01-15"
    }

    // ── padIndex ────────────────────────────────────────────────────────

    @Test
    fun `padIndex pads single digit`() {
        SummaryUtils.padIndex(0) shouldBe "01"
        SummaryUtils.padIndex(8) shouldBe "09"
    }

    @Test
    fun `padIndex does not pad double digit`() {
        SummaryUtils.padIndex(10) shouldBe "11"
        SummaryUtils.padIndex(99) shouldBe "100"
    }

    // ── renderCalloutText ───────────────────────────────────────────────

    @Nested
    inner class RenderCalloutText {
        @Test
        fun `renders plain text`() {
            val result = SummaryUtils.renderCalloutText("Hello world")
            result shouldContain "Hello world"
        }

        @Test
        fun `converts markdown lists to HTML`() {
            val result = SummaryUtils.renderCalloutText("- Item 1\n- Item 2")
            result shouldContain "<ul>"
            result shouldContain "<li>Item 1</li>"
            result shouldContain "<li>Item 2</li>"
        }

        @Test
        fun `converts bold markers to strong tags`() {
            val result = SummaryUtils.renderCalloutText("This is **bold** text")
            result shouldContain "<strong>bold</strong>"
        }

        @Test
        fun `escapes HTML in content`() {
            val result = SummaryUtils.renderCalloutText("<script>alert('xss')</script>")
            result shouldNotContain "<script>"
            result shouldContain "&lt;script&gt;"
        }
    }

    // ── buildPanelTitle ─────────────────────────────────────────────────

    @Nested
    inner class BuildPanelTitle {
        @Test
        fun `includes date, hash, and author`() {
            val summary = CommitSummary(
                commitHash = "abc1234567890",
                commitMessage = "Fix bug",
                commitAuthor = "Alice",
                commitDate = "2026-01-15T10:00:00Z",
                branch = "main",
                generatedAt = "2026-01-15T10:00:00Z",
            )
            val title = SummaryUtils.buildPanelTitle(summary)
            title shouldContain "2026-01-15"
            title shouldContain "abc1234"
            title shouldContain "Alice"
        }

        @Test
        fun `includes ticket from summary`() {
            val summary = CommitSummary(
                commitHash = "abc1234567890",
                commitMessage = "Fix bug",
                commitAuthor = "Alice",
                commitDate = "2026-01-15T10:00:00Z",
                branch = "main",
                generatedAt = "2026-01-15T10:00:00Z",
                ticketId = "PROJ-123",
            )
            SummaryUtils.buildPanelTitle(summary) shouldContain "PROJ-123"
        }

        @Test
        fun `extracts ticket from commit message`() {
            val summary = CommitSummary(
                commitHash = "abc1234567890",
                commitMessage = "Fixes PROJ-456: Fix bug",
                commitAuthor = "Alice",
                commitDate = "2026-01-15T10:00:00Z",
                branch = "main",
                generatedAt = "2026-01-15T10:00:00Z",
            )
            SummaryUtils.buildPanelTitle(summary) shouldContain "PROJ-456"
        }

        @Test
        fun `extracts ticket from branch name`() {
            val summary = CommitSummary(
                commitHash = "abc1234567890",
                commitMessage = "Fix bug",
                commitAuthor = "Alice",
                commitDate = "2026-01-15T10:00:00Z",
                branch = "feature/proj-789-something",
                generatedAt = "2026-01-15T10:00:00Z",
            )
            SummaryUtils.buildPanelTitle(summary) shouldContain "PROJ-789"
        }
    }

    // ── categoryClass ───────────────────────────────────────────────────

    @Nested
    inner class CategoryClass {
        @Test
        fun `maps feature to cat-feature`() {
            SummaryUtils.categoryClass("feature") shouldBe "cat-feature"
        }

        @Test
        fun `maps bugfix to cat-bugfix`() {
            SummaryUtils.categoryClass("bugfix") shouldBe "cat-bugfix"
        }

        @Test
        fun `maps refactor group`() {
            SummaryUtils.categoryClass("refactor") shouldBe "cat-refactor"
            SummaryUtils.categoryClass("tech-debt") shouldBe "cat-refactor"
            SummaryUtils.categoryClass("performance") shouldBe "cat-refactor"
        }

        @Test
        fun `maps infra group`() {
            SummaryUtils.categoryClass("devops") shouldBe "cat-infra"
            SummaryUtils.categoryClass("security") shouldBe "cat-infra"
        }

        @Test
        fun `maps docs group`() {
            SummaryUtils.categoryClass("test") shouldBe "cat-docs"
            SummaryUtils.categoryClass("docs") shouldBe "cat-docs"
            SummaryUtils.categoryClass("ux") shouldBe "cat-docs"
        }

        @Test
        fun `returns empty for null`() {
            SummaryUtils.categoryClass(null) shouldBe ""
        }

        @Test
        fun `returns empty for unknown`() {
            SummaryUtils.categoryClass("unknown") shouldBe ""
        }
    }

    // ── collectAllPlans ─────────────────────────────────────────────────

    @Nested
    inner class CollectAllPlans {
        @Test
        fun `collects plans from summary`() {
            val summary = CommitSummary(
                commitHash = "abc", commitMessage = "msg", commitAuthor = "a",
                commitDate = "2026-01-01T00:00:00Z", branch = "main",
                generatedAt = "2026-01-01T00:00:00Z",
                plans = listOf(PlanReference("plan1", "Plan One", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
            )
            val plans = SummaryUtils.collectAllPlans(summary)
            plans shouldHaveSize 1
            plans[0].slug shouldBe "plan1"
        }

        @Test
        fun `deduplicates plans by slug keeping newest`() {
            val child1 = CommitSummary(
                commitHash = "c1", commitMessage = "msg", commitAuthor = "a",
                commitDate = "2026-01-01T00:00:00Z", branch = "main",
                generatedAt = "2026-01-01T00:00:00Z",
                plans = listOf(PlanReference("plan1", "Old Plan", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")),
            )
            val parent = CommitSummary(
                commitHash = "p1", commitMessage = "msg", commitAuthor = "a",
                commitDate = "2026-01-02T00:00:00Z", branch = "main",
                generatedAt = "2026-01-02T00:00:00Z",
                plans = listOf(PlanReference("plan1", "New Plan", 2, "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")),
                children = listOf(child1),
            )
            val plans = SummaryUtils.collectAllPlans(parent)
            plans shouldHaveSize 1
            plans[0].title shouldBe "New Plan"
        }

        @Test
        fun `returns empty for no plans`() {
            val summary = CommitSummary(
                commitHash = "abc", commitMessage = "msg", commitAuthor = "a",
                commitDate = "2026-01-01T00:00:00Z", branch = "main",
                generatedAt = "2026-01-01T00:00:00Z",
            )
            SummaryUtils.collectAllPlans(summary).shouldBeEmpty()
        }
    }

    // ── groupTopicsByDate ───────────────────────────────────────────────

    @Test
    fun `groupTopicsByDate groups by date prefix`() {
        val topics = listOf(
            SummaryUtils.ViewTopicWithDate(
                topic = SummaryTree.TopicWithDate(TopicSummary("A", "t", "r", "d")),
                recordDate = "2026-01-15T10:00:00Z",
            ),
            SummaryUtils.ViewTopicWithDate(
                topic = SummaryTree.TopicWithDate(TopicSummary("B", "t", "r", "d")),
                recordDate = "2026-01-15T14:00:00Z",
            ),
            SummaryUtils.ViewTopicWithDate(
                topic = SummaryTree.TopicWithDate(TopicSummary("C", "t", "r", "d")),
                recordDate = "2026-01-16T10:00:00Z",
            ),
        )
        val groups = SummaryUtils.groupTopicsByDate(topics)
        groups.size shouldBe 2
        groups["2026-01-15"]!! shouldHaveSize 2
        groups["2026-01-16"]!! shouldHaveSize 1
    }
}
