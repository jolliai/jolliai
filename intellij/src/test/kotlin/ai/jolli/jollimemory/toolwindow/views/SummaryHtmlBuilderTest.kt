package ai.jolli.jollimemory.toolwindow.views

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.DiffStats
import ai.jolli.jollimemory.core.E2eTestScenario
import ai.jolli.jollimemory.core.ExcludedContext
import ai.jolli.jollimemory.core.PlanReference
import ai.jolli.jollimemory.core.SummaryTree
import ai.jolli.jollimemory.core.TopicCategory
import ai.jolli.jollimemory.core.TopicImportance
import ai.jolli.jollimemory.core.TopicSummary
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SummaryHtmlBuilderTest {

    private fun makeTopic(title: String = "Test Topic", cat: TopicCategory? = TopicCategory.feature) =
        TopicSummary(title, "Test trigger", "Test response", "Test decision", category = cat)

    private fun makeSummary(
        hash: String = "abc1234567890",
        topics: List<TopicSummary> = listOf(makeTopic()),
        e2e: List<E2eTestScenario>? = null,
        plans: List<PlanReference>? = null,
        children: List<CommitSummary>? = null,
        jolliDocUrl: String? = null,
        turns: Int? = null,
    ) = CommitSummary(
        commitHash = hash,
        commitMessage = "Fix the login bug",
        commitAuthor = "Alice",
        commitDate = "2026-01-15T10:30:00Z",
        branch = "main",
        generatedAt = "2026-01-15T10:35:00Z",
        stats = DiffStats(3, 100, 50),
        topics = topics,
        e2eTestGuide = e2e,
        plans = plans,
        children = children,
        jolliDocUrl = jolliDocUrl,
        conversationTurns = turns,
    )

    @Nested
    inner class BuildHtml {
        @Test
        fun `returns valid HTML document`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain "<!DOCTYPE html>"
            html shouldContain "<html"
            html shouldContain "</html>"
        }

        @Test
        fun `includes commit message as title`() {
            SummaryHtmlBuilder.buildHtml(makeSummary()) shouldContain "Fix the login bug"
        }

        @Test
        fun `includes CSS and script`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain "<style>"
            html shouldContain "<script>"
        }

        @Test
        fun `includes topic content`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain "Test Topic"
            html shouldContain "Test trigger"
            html shouldContain "Test decision"
        }

        @Test
        fun `shows empty message for no topics`() {
            SummaryHtmlBuilder.buildHtml(makeSummary(topics = emptyList())) shouldContain "No topics available for this commit."
        }

        @Test
        fun `includes bridge script when provided`() {
            SummaryHtmlBuilder.buildHtml(makeSummary(), bridgeScript = "console.log('bridge')") shouldContain "console.log('bridge')"
        }

        @Test
        fun `renders Jolli row when jolliDocUrl is set`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(jolliDocUrl = "https://test.jolli.ai/articles/1"))
            html shouldContain "jolliRow"
            html shouldContain "https://test.jolli.ai/articles/1"
        }

        @Test
        fun `omits Jolli row when no URL`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(jolliDocUrl = null))
            html shouldNotContain "id=\"jolliRow\""
        }

        @Test
        fun `renders conversations row when turns greater than zero`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(turns = 5))
            html shouldContain "5 turn"
        }

        @Test
        fun `omits conversations stat when null turns`() {
            // Default turns = null, so no conversation turn count in the header
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(turns = null))
            // The conversations prop-row should not be present since aggregateTurns = 0
            html shouldNotContain "class=\"stat-turns\""
        }

        @Test
        fun `renders plans section`() {
            val plans = listOf(PlanReference("p1", "My Plan", 2, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(plans = plans))
            html shouldContain "plansSection"
            html shouldContain "My Plan"
            html shouldContain "edited 2 times"
        }

        @Test
        fun `renders plans section with no plans placeholder`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(plans = null))
            html shouldContain "No plans associated"
        }

        @Test
        fun `renders plans with translate button when in translateSet`() {
            val plans = listOf(PlanReference("p1", "Plan", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(plans = plans), planTranslateSet = setOf("p1"))
            html shouldContain "plan-translate-btn"
        }

        @Test
        fun `renders source commits for squash summary`() {
            val child1 = CommitSummary(commitHash = "child1abcdef", commitMessage = "C1", commitAuthor = "A",
                commitDate = "2026-01-14T10:00:00Z", branch = "main", generatedAt = "2026-01-14T10:00:00Z",
                topics = listOf(makeTopic("Child 1")), stats = DiffStats(1, 10, 5))
            val child2 = CommitSummary(commitHash = "child2abcdef", commitMessage = "C2", commitAuthor = "A",
                commitDate = "2026-01-15T10:00:00Z", branch = "main", generatedAt = "2026-01-15T10:00:00Z",
                topics = listOf(makeTopic("Child 2")), stats = DiffStats(1, 10, 5))
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(children = listOf(child1, child2), topics = emptyList()))
            html shouldContain "Source Commits"
            html shouldContain "child1ab"
        }

        @Test
        fun `renders timeline for multi-day squash`() {
            val child1 = CommitSummary(
                commitHash = "ch1", commitMessage = "C1", commitAuthor = "A",
                commitDate = "2026-01-10T10:00:00Z", branch = "main", generatedAt = "2026-01-10T10:00:00Z",
                topics = listOf(makeTopic("Topic A")), stats = DiffStats(1, 10, 5),
            )
            val child2 = CommitSummary(
                commitHash = "ch2", commitMessage = "C2", commitAuthor = "A",
                commitDate = "2026-01-12T10:00:00Z", branch = "main", generatedAt = "2026-01-12T10:00:00Z",
                topics = listOf(makeTopic("Topic B")), stats = DiffStats(1, 10, 5),
            )
            val parent = makeSummary(children = listOf(child1, child2), topics = emptyList())
            val html = SummaryHtmlBuilder.buildHtml(parent)
            html shouldContain "timeline"
        }

        @Test
        fun `renders conversations section when transcriptHashSet is non-empty`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(), transcriptHashSet = setOf("abc123"))
            html shouldContain "All Conversations"
            html shouldContain "Manage"
            html shouldContain "transcriptModal"
        }

        @Test
        fun `renders empty conversations section when no transcripts`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(), transcriptHashSet = emptySet())
            html shouldContain "All Conversations"
            html shouldContain "No conversation transcripts"
        }
    }

    // ── buildE2eTestSection ─────────────────────────────────────────────

    @Nested
    inner class BuildE2eTestSection {
        @Test
        fun `shows placeholder when no scenarios`() {
            val html = SummaryHtmlBuilder.buildE2eTestSection(makeSummary())
            html shouldContain "Generate step-by-step"
            html shouldContain "generateE2eBtn"
        }

        @Test
        fun `renders scenarios with preconditions`() {
            val e2e = listOf(
                E2eTestScenario("Login flow", "Have account", listOf("Open app", "Click login"), listOf("Dashboard shows")),
            )
            val html = SummaryHtmlBuilder.buildE2eTestSection(makeSummary(e2e = e2e))
            html shouldContain "Login flow"
            html shouldContain "Preconditions"
            html shouldContain "Have account"
            html shouldContain "Open app"
            html shouldContain "Dashboard shows"
        }

        @Test
        fun `renders scenario without preconditions`() {
            val e2e = listOf(
                E2eTestScenario("Simple test", null, listOf("Do thing"), listOf("Thing happens")),
            )
            val html = SummaryHtmlBuilder.buildE2eTestSection(makeSummary(e2e = e2e))
            html shouldNotContain "Preconditions"
        }

        @Test
        fun `shows edit and delete buttons for existing scenarios`() {
            val e2e = listOf(E2eTestScenario("Test", steps = listOf("Step"), expectedResults = listOf("Result")))
            val html = SummaryHtmlBuilder.buildE2eTestSection(makeSummary(e2e = e2e))
            html shouldContain "editE2eBtn"
            html shouldContain "regenE2eBtn"
            html shouldContain "deleteE2eBtn"
        }
    }

    // ── renderTopic ─────────────────────────────────────────────────────

    @Nested
    inner class RenderTopic {
        @Test
        fun `renders all fields`() {
            val topic = TopicSummary("My Topic", "Trigger", "Response", "Decision",
                todo = "Todo item", filesAffected = listOf("src/file.ts"),
                category = TopicCategory.feature, importance = TopicImportance.major)
            val viewTopic = SummaryUtils.ViewTopicWithDate(topic = SummaryTree.TopicWithDate(topic))
            val html = SummaryHtmlBuilder.renderTopic(viewTopic, 0)
            html shouldContain "My Topic"
            html shouldContain "Trigger"
            html shouldContain "Decision"
            html shouldContain "Response"
            html shouldContain "Todo item"
            html shouldContain "src/file.ts"
            html shouldContain "cat-feature"
        }

        @Test
        fun `hides empty todo and files`() {
            val topic = TopicSummary("Title", "Trigger", "Response", "Decisions")
            val viewTopic = SummaryUtils.ViewTopicWithDate(topic = SummaryTree.TopicWithDate(topic))
            val html = SummaryHtmlBuilder.renderTopic(viewTopic, 0)
            html shouldContain "hidden"
        }

        @Test
        fun `adds minor class for minor importance`() {
            val topic = TopicSummary("Title", "T", "R", "D", importance = TopicImportance.minor)
            val viewTopic = SummaryUtils.ViewTopicWithDate(topic = SummaryTree.TopicWithDate(topic))
            SummaryHtmlBuilder.renderTopic(viewTopic, 0) shouldContain "minor"
        }

        @Test
        fun `uses treeIndex for operations when available`() {
            val topic = TopicSummary("Title", "T", "R", "D")
            val viewTopic = SummaryUtils.ViewTopicWithDate(topic = SummaryTree.TopicWithDate(topic, treeIndex = 5))
            val html = SummaryHtmlBuilder.renderTopic(viewTopic, 0)
            html shouldContain "topic-5"
            html shouldContain "data-topic-index=\"5\""
        }

        @Test
        fun `escapes HTML in topic data`() {
            val topic = TopicSummary("<script>", "T&R", "R", "D")
            val viewTopic = SummaryUtils.ViewTopicWithDate(topic = SummaryTree.TopicWithDate(topic))
            val html = SummaryHtmlBuilder.renderTopic(viewTopic, 0)
            html shouldNotContain "<script>"
            html shouldContain "&lt;script&gt;"
        }
    }

    // ── Export dropdown ────────────────────────────────────────────────────

    @Nested
    inner class ExportMenu {
        @Test
        fun `renders the export dropdown with copy and save-as-markdown items`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain """id="exportMenuToggle""""
            html shouldContain """id="exportMenu""""
            html shouldContain """id="copyMdBtn""""
            html shouldContain "Copy Markdown"
            html shouldContain """id="downloadMdBtn""""
            html shouldContain "Save as Markdown File"
        }

        @Test
        fun `wires the download-markdown command and dropdown toggle in the script`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain "command: 'downloadMarkdown'"
            html shouldContain "exportMenu.classList.toggle('open')"
        }
    }

    // ── Meta strip alignment (matches VS Code) ──────────────────────────────

    @Nested
    inner class MetaStrip {
        @Test
        fun `omits author, line changes, and conversation turns from the meta strip`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary(turns = 5))
            // These no longer live in the sub-title strip.
            html shouldNotContain "meta-author"
            html shouldNotContain "meta-changes"
            // Author still appears in the collapsed Details table.
            html shouldContain "Alice"
        }

        @Test
        fun `hoists the share link and export buttons onto the meta strip`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain """id="shareLinkBtn""""
            html shouldContain "meta-share"
            html shouldContain "meta-export"
            // The separate header-actions row is gone.
            html shouldNotContain """class="header-actions""""
        }
    }

    // ── Token/cost banner ──────────────────────────────────────────────────

    @Nested
    inner class TokenMeter {
        @Test
        fun `renders the not-reported state when no usage is recorded`() {
            val html = SummaryHtmlBuilder.buildHtml(makeSummary())
            html shouldContain "tmeter-na"
            html shouldContain "Task usage not reported"
        }

        @Test
        fun `renders total, cost, and segmented breakdown when usage is present`() {
            val summary = makeSummary().copy(
                conversationTokens = 274_400,
                conversationTokenBreakdown = ai.jolli.jollimemory.core.ConversationTokenBreakdown(
                    input = 123_400, output = 109_800, cached = 41_200,
                ),
                estimatedCostUsd = 0.42,
            )
            val html = SummaryHtmlBuilder.buildHtml(summary)
            html shouldNotContain "Task usage not reported"
            html shouldContain "274k"
            html shouldContain "≈$0.42"
            html shouldContain "123k input"
            html shouldContain "110k output"
            html shouldContain "41.2k cached"
            html shouldContain """<span class="seg-in" style="width:"""
        }

        @Test
        fun `estimates cost at Sonnet rates when a breakdown exists but no stored cost`() {
            // Legacy/token-only memory: no estimatedCostUsd. Detail view shows an approximate
            // Sonnet-rate cost (prefer-stored-else-Sonnet), matching the VS Code sidebar.
            val summary = makeSummary().copy(
                conversationTokens = 3_000_000,
                conversationTokenBreakdown = ai.jolli.jollimemory.core.ConversationTokenBreakdown(
                    input = 1_000_000, output = 1_000_000, cached = 1_000_000,
                ),
                estimatedCostUsd = null,
            )
            val html = SummaryHtmlBuilder.buildHtml(summary)
            html shouldNotContain "cost N/A"
            html shouldContain "≈$21.75" // 1M*3 + 1M*15 + 1M*3.75 per 1M
        }

        @Test
        fun `degrades to a single segment and estimates a bare total at Sonnet input rate`() {
            val summary = makeSummary().copy(conversationTokens = 5_000)
            val html = SummaryHtmlBuilder.buildHtml(summary)
            html shouldContain "5k"
            // 5000 * $3/1M input rate -> ~$0.015, shown as an ≈ estimate (not N/A).
            html shouldContain "≈$"
            html shouldNotContain "cost N/A"
            html shouldContain """<span class="seg-in" style="width:100%">"""
        }
    }

    @Nested
    inner class ExcludedContextSection {
        @Test
        fun `renders a collapsed details disclosure with count, title, and reason`() {
            val summary = makeSummary().copy(
                excludedContext = listOf(
                    ExcludedContext(kind = "plan", key = "p1", title = "Unrelated Plan", reason = "different feature area"),
                    ExcludedContext(kind = "reference", key = "linear:JOLLI-9", title = "JOLLI-9 — Old ticket", reason = ""),
                ),
            )
            val html = SummaryHtmlBuilder.buildHtml(summary)
            html shouldContain """<details class="excluded-context">"""
            html shouldContain "AI judged 2 context item(s) unrelated (not included)"
            html shouldContain "Unrelated Plan"
            html shouldContain "different feature area"
            html shouldContain "JOLLI-9 — Old ticket"
        }

        @Test
        fun `renders nothing when excludedContext is null`() {
            SummaryHtmlBuilder.buildHtml(makeSummary()) shouldNotContain "unrelated (not included)"
        }

        @Test
        fun `renders nothing when excludedContext is empty`() {
            val summary = makeSummary().copy(excludedContext = emptyList())
            SummaryHtmlBuilder.buildHtml(summary) shouldNotContain "unrelated (not included)"
        }
    }
}
