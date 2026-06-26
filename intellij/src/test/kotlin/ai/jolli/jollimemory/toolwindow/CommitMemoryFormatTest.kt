package ai.jolli.jollimemory.toolwindow

import ai.jolli.jollimemory.bridge.CommitSummaryBrief
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CommitMemoryFormatTest {

    private fun brief(
        hash: String,
        hasSummary: Boolean = true,
        inputTokens: Int? = null,
        outputTokens: Int? = null,
    ) = CommitSummaryBrief(
        hash = hash,
        shortHash = hash.take(7),
        message = "msg $hash",
        author = "Dev",
        date = "2026-01-01T00:00:00Z",
        hasSummary = hasSummary,
        inputTokens = inputTokens,
        outputTokens = outputTokens,
    )

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
        fun `sums reported input and output across memory commits`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", inputTokens = 100, outputTokens = 50),
                    brief("b", inputTokens = 400, outputTokens = 200),
                ),
            )
            totals.input shouldBe 500L
            totals.output shouldBe 250L
            totals.total shouldBe 750L
            totals.partial shouldBe false
            totals.hasData shouldBe true
        }

        @Test
        fun `flags partial when a memory commit reports no usage`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", inputTokens = 100, outputTokens = 50),
                    brief("b", inputTokens = null, outputTokens = null),
                ),
            )
            totals.total shouldBe 150L
            totals.partial shouldBe true
        }

        @Test
        fun `ignores code-only commits entirely`() {
            val totals = CommitMemoryFormat.aggregateTokens(
                listOf(
                    brief("a", hasSummary = false, inputTokens = null, outputTokens = null),
                    brief("b", inputTokens = 10, outputTokens = 5),
                ),
            )
            totals.total shouldBe 15L
            // The code-only commit must not flip partial.
            totals.partial shouldBe false
        }
    }
}
