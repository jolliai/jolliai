package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.core.ConversationTokenBreakdown
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CommitMemoryFormatTest {

    private fun brief(
        hash: String,
        hasSummary: Boolean = true,
        breakdown: ConversationTokenBreakdown? = null,
        cost: Double? = null,
    ) = CommitSummaryBrief(
        hash = hash,
        shortHash = hash.take(7),
        message = "msg $hash",
        author = "Dev",
        date = "2026-01-01T00:00:00Z",
        hasSummary = hasSummary,
        conversationTokenBreakdown = breakdown,
        estimatedCostUsd = cost,
    )

    private fun bd(input: Long, output: Long, cached: Long = 0) =
        ConversationTokenBreakdown(input, output, cached)

    @Nested
    inner class FormatTokens {
        @Test
        fun `renders raw counts below 1k`() {
            CommitMemoryFormat.formatTokens(0) shouldBe "0"
            CommitMemoryFormat.formatTokens(842) shouldBe "842"
            CommitMemoryFormat.formatTokens(999) shouldBe "999"
        }

        @Test
        fun `renders thousands with a trimmed k suffix`() {
            CommitMemoryFormat.formatTokens(1_000) shouldBe "1k"
            CommitMemoryFormat.formatTokens(1_500) shouldBe "1.5k"
            CommitMemoryFormat.formatTokens(61_000) shouldBe "61k"
            CommitMemoryFormat.formatTokens(96_000) shouldBe "96k"
            // >= 100 of a unit drops the decimal entirely.
            CommitMemoryFormat.formatTokens(308_000) shouldBe "308k"
        }

        @Test
        fun `renders millions with one decimal under 100`() {
            CommitMemoryFormat.formatTokens(1_200_000) shouldBe "1.2M"
            CommitMemoryFormat.formatTokens(1_400_000) shouldBe "1.4M"
            CommitMemoryFormat.formatTokens(9_200_000) shouldBe "9.2M"
            CommitMemoryFormat.formatTokens(120_000_000) shouldBe "120M"
        }
    }

    @Nested
    inner class AggregateTokens {
        @Test
        fun `empty list has no data`() {
            val totals = CommitMemoryFormat.aggregateTokens(emptyList())
            totals.total shouldBe 0L
            totals.partial shouldBe false
            totals.hasData shouldBe false
        }

        @Test
        fun `sums input, output and cache (cache_creation) across memory commits`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", breakdown = bd(100, 50, cached = 200)),
                    brief("b", breakdown = bd(400, 200, cached = 0)),
                ),
            )
            totals.input shouldBe 500L
            totals.output shouldBe 250L
            // cache_read is excluded; `cached` carries cache_creation only.
            totals.cacheRead shouldBe 0L
            totals.cached shouldBe 200L
            totals.total shouldBe 950L
            totals.partial shouldBe false
            totals.hasData shouldBe true
        }

        @Test
        fun `flags partial when a memory commit reports no usage`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", breakdown = bd(100, 50)),
                    brief("b", breakdown = null),
                ),
            )
            totals.total shouldBe 150L
            totals.partial shouldBe true
        }

        @Test
        fun `ignores code-only commits entirely`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", hasSummary = false, breakdown = null),
                    brief("b", breakdown = bd(10, 5)),
                ),
            )
            totals.total shouldBe 15L
            // The code-only commit must not flip partial.
            totals.partial shouldBe false
        }

        @Test
        fun `sums per-commit estimated cost across the branch`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", breakdown = bd(100, 50), cost = 0.25),
                    brief("b", breakdown = bd(400, 200), cost = 0.50),
                ),
            )
            totals.estimatedCostUsd shouldBe 0.75
        }

        @Test
        fun `cost stays null when no memory carries a priced estimate`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(brief("a", breakdown = bd(100, 50))),
            )
            totals.estimatedCostUsd shouldBe null
        }
    }

    @Nested
    inner class FormatCost {
        @Test
        fun `renders two decimals with the approx-dollar prefix`() {
            CommitMemoryFormat.formatCost(0.42) shouldBe "≈$0.42"
            CommitMemoryFormat.formatCost(12.5) shouldBe "≈$12.50"
        }

        @Test
        fun `renders a tiny non-zero estimate as less-than-a-cent`() {
            CommitMemoryFormat.formatCost(0.004) shouldBe "<$0.01"
        }
    }
}
