package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import ai.jolli.jollimemory.core.TokenUsage
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CommitMemoryFormatTest {

    private fun brief(
        hash: String,
        hasSummary: Boolean = true,
        tokenUsage: TokenUsage? = null,
    ) = CommitSummaryBrief(
        hash = hash,
        shortHash = hash.take(7),
        message = "msg $hash",
        author = "Dev",
        date = "2026-01-01T00:00:00Z",
        hasSummary = hasSummary,
        tokenUsage = tokenUsage,
    )

    private fun usage(input: Long, output: Long, cacheRead: Long = 0, cacheWrite: Long = 0, reported: Int = 1, total: Int = 1) =
        TokenUsage(input, output, cacheRead, cacheWrite, reported, total)

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
        fun `sums input, output and cache across memory commits`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", tokenUsage = usage(100, 50, cacheRead = 1000, cacheWrite = 200)),
                    brief("b", tokenUsage = usage(400, 200, cacheRead = 3000, cacheWrite = 0)),
                ),
            )
            totals.input shouldBe 500L
            totals.output shouldBe 250L
            totals.cacheRead shouldBe 4000L
            totals.cacheWrite shouldBe 200L
            totals.cached shouldBe 4200L
            totals.total shouldBe 4950L
            totals.partial shouldBe false
            totals.hasData shouldBe true
        }

        @Test
        fun `flags partial when a memory commit reports no usage`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", tokenUsage = usage(100, 50)),
                    brief("b", tokenUsage = null),
                ),
            )
            totals.total shouldBe 150L
            totals.partial shouldBe true
        }

        @Test
        fun `flags partial when a commit's own usage is partial`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(brief("a", tokenUsage = usage(100, 50, reported = 1, total = 2))),
            )
            totals.partial shouldBe true
        }

        @Test
        fun `ignores code-only commits entirely`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", hasSummary = false, tokenUsage = null),
                    brief("b", tokenUsage = usage(10, 5)),
                ),
            )
            totals.total shouldBe 15L
            // The code-only commit must not flip partial.
            totals.partial shouldBe false
        }
    }
}
