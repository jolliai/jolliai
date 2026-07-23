package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

/**
 * Tests for [ConversationUsage.aggregate] (the canonical token/cost aggregation).
 * cache_read is excluded from every total, matching the CLI/VS Code side.
 */
class TokenUsageTest {

    private fun entry(usage: MessageUsage?) = TranscriptEntry("assistant", "x", null, usage)
    private fun session(id: String, entries: List<TranscriptEntry>) =
        StoredSession(sessionId = id, entries = entries)

    @Nested
    inner class Aggregate {
        @Test
        fun `empty sessions yields null`() {
            ConversationUsage.aggregate(emptyList()) shouldBe null
        }

        @Test
        fun `null when no session reported usage`() {
            val s = session("s1", listOf(entry(null), entry(null)))
            ConversationUsage.aggregate(listOf(s)) shouldBe null
        }

        @Test
        fun `sums input + output + cache_creation, EXCLUDING cache_read`() {
            val reported = session(
                "s1",
                listOf(
                    entry(MessageUsage(inputTokens = 100, outputTokens = 50, cacheReadTokens = 10, cacheWriteTokens = 5)),
                    entry(null), // mixed: contributes nothing but doesn't break aggregation
                    entry(MessageUsage(inputTokens = 400, outputTokens = 200, cacheReadTokens = 30)),
                ),
            )
            val unreported = session("s2", listOf(entry(null)))

            val agg = ConversationUsage.aggregate(listOf(reported, unreported))!!
            // cache_read (10 + 30 = 40) is intentionally NOT counted.
            agg.breakdown shouldBe ConversationTokenBreakdown(input = 500, output = 250, cached = 5)
            agg.conversationTokens shouldBe 755 // 500 + 250 + 5
        }
    }

    @Nested
    inner class Cost {
        @Test
        fun `buckets per model and prices from input + output + cache_creation`() {
            val agg = ConversationUsage.aggregate(
                listOf(
                    session(
                        "s1",
                        listOf(
                            entry(
                                MessageUsage(
                                    inputTokens = 1_000_000,
                                    outputTokens = 1_000_000,
                                    cacheReadTokens = 9_000_000, // must NOT affect cost
                                    cacheWriteTokens = 1_000_000,
                                    model = "claude-opus-4-8",
                                ),
                            ),
                        ),
                    ),
                ),
            )!!
            agg.models shouldBe listOf(
                ModelTokenUsage("claude-opus-4-8", "anthropic", 1_000_000, 1_000_000, 1_000_000),
            )
            // 5 (input) + 25 (output) + 6.25 (cache_write); cache_read ignored.
            agg.estimatedCostUsd shouldBe (5.0 + 25.0 + 6.25)
        }

        @Test
        fun `merges same model across sessions and keeps distinct models separate`() {
            val agg = ConversationUsage.aggregate(
                listOf(
                    session("s1", listOf(entry(MessageUsage(inputTokens = 1_000_000, model = "claude-opus-4-8")))),
                    session("s2", listOf(entry(MessageUsage(outputTokens = 1_000_000, model = "claude-opus-4-8")))),
                    session("s3", listOf(entry(MessageUsage(inputTokens = 1_000_000, model = "claude-haiku-4-5")))),
                ),
            )!!
            agg.models shouldBe listOf(
                ModelTokenUsage("claude-opus-4-8", "anthropic", 1_000_000, 1_000_000, 0),
                ModelTokenUsage("claude-haiku-4-5", "anthropic", 1_000_000, 0, 0),
            )
            // opus: 5 + 25 = 30 ; haiku: 1 → 31
            agg.estimatedCostUsd shouldBe 31.0
        }

        @Test
        fun `no cost when the model is unpriced or unrecorded`() {
            val unpriced = ConversationUsage.aggregate(
                listOf(session("s1", listOf(entry(MessageUsage(inputTokens = 500, model = "mystery-model"))))),
            )!!
            unpriced.estimatedCostUsd shouldBe null
            unpriced.models shouldBe listOf(ModelTokenUsage("mystery-model", "unknown", 500, 0, 0))

            val noModel = ConversationUsage.aggregate(
                listOf(session("s1", listOf(entry(MessageUsage(inputTokens = 500))))),
            )!!
            noModel.estimatedCostUsd shouldBe null
        }
    }
}
