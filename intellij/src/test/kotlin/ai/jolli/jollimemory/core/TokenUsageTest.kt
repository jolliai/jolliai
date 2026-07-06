package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class TokenUsageTest {

    private fun entry(usage: MessageUsage?) = TranscriptEntry("assistant", "x", null, usage)
    private fun session(id: String, entries: List<TranscriptEntry>) =
        StoredSession(sessionId = id, entries = entries)

    @Nested
    inner class Aggregate {
        @Test
        fun `empty sessions yields null`() {
            TokenUsage.aggregate(emptyList()) shouldBe null
        }

        @Test
        fun `null when no session reported usage`() {
            val s = session("s1", listOf(entry(null), entry(null)))
            TokenUsage.aggregate(listOf(s)) shouldBe null
        }

        @Test
        fun `sums per-message usage and counts reported vs total sessions`() {
            val reported = session(
                "s1",
                listOf(
                    entry(MessageUsage(inputTokens = 100, outputTokens = 50, cacheReadTokens = 10, cacheWriteTokens = 5)),
                    entry(null), // mixed: still counts the session as reported
                    entry(MessageUsage(inputTokens = 400, outputTokens = 200, cacheReadTokens = 30)),
                ),
            )
            val unreported = session("s2", listOf(entry(null)))

            val agg = TokenUsage.aggregate(listOf(reported, unreported))!!
            agg.inputTokens shouldBe 500L
            agg.outputTokens shouldBe 250L
            agg.cacheReadTokens shouldBe 40L
            agg.cacheWriteTokens shouldBe 5L
            agg.total shouldBe 795L
            agg.reportedSessions shouldBe 1
            agg.totalSessions shouldBe 2
            agg.partial shouldBe true // 1 of 2 sessions reported
        }

        @Test
        fun `not partial when all sessions reported`() {
            val agg = TokenUsage.aggregate(listOf(session("s1", listOf(entry(MessageUsage(10, 5))))))!!
            agg.partial shouldBe false
            agg.reportedSessions shouldBe 1
            agg.totalSessions shouldBe 1
        }
    }

    @Nested
    inner class Cost {
        @Test
        fun `buckets per model and prices from cache_write + input + output (excludes cache_read)`() {
            val agg = TokenUsage.aggregate(
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
                ModelUsage("claude-opus-4-8", "anthropic", 1_000_000, 1_000_000, 1_000_000),
            )
            // 5 (input) + 25 (output) + 6.25 (cache_write); cache_read ignored.
            agg.estimatedCostUsd shouldBe (5.0 + 25.0 + 6.25)
        }

        @Test
        fun `merges same model across sessions and keeps distinct models separate`() {
            val agg = TokenUsage.aggregate(
                listOf(
                    session("s1", listOf(entry(MessageUsage(inputTokens = 1_000_000, model = "claude-opus-4-8")))),
                    session("s2", listOf(entry(MessageUsage(outputTokens = 1_000_000, model = "claude-opus-4-8")))),
                    session("s3", listOf(entry(MessageUsage(inputTokens = 1_000_000, model = "claude-haiku-4-5")))),
                ),
            )!!
            agg.models shouldBe listOf(
                ModelUsage("claude-opus-4-8", "anthropic", 1_000_000, 1_000_000, 0),
                ModelUsage("claude-haiku-4-5", "anthropic", 1_000_000, 0, 0),
            )
            // opus: 5 + 25 = 30 ; haiku: 1 → 31
            agg.estimatedCostUsd shouldBe 31.0
        }

        @Test
        fun `no cost when the model is unpriced or unrecorded`() {
            val unpriced = TokenUsage.aggregate(
                listOf(session("s1", listOf(entry(MessageUsage(inputTokens = 500, model = "mystery-model"))))),
            )!!
            unpriced.estimatedCostUsd shouldBe null
            unpriced.models shouldBe listOf(ModelUsage("mystery-model", "unknown", 500, 0, 0))

            val noModel = TokenUsage.aggregate(
                listOf(session("s1", listOf(entry(MessageUsage(inputTokens = 500))))),
            )!!
            noModel.estimatedCostUsd shouldBe null
        }
    }

    @Nested
    inner class ParseUsage {
        @Test
        fun `parses Claude message dot usage into the entry`() {
            val line = """
                {"timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant",
                "content":"hello","usage":{"input_tokens":11176,"output_tokens":237,
                "cache_read_input_tokens":19604,"cache_creation_input_tokens":13064}}}
            """.trimIndent().replace("\n", "")
            val e = TranscriptReader.parseTranscriptLine(line, 0)!!
            e.role shouldBe "assistant"
            e.usage shouldBe MessageUsage(
                inputTokens = 11176,
                outputTokens = 237,
                cacheReadTokens = 19604,
                cacheWriteTokens = 13064,
            )
        }

        @Test
        fun `captures message dot model onto the usage for pricing`() {
            val line = """
                {"message":{"role":"assistant","model":"claude-opus-4-8",
                "content":"hi","usage":{"input_tokens":10,"output_tokens":2}}}
            """.trimIndent().replace("\n", "")
            TranscriptReader.parseTranscriptLine(line, 0)!!.usage!!.model shouldBe "claude-opus-4-8"
        }

        @Test
        fun `model defaults to empty when absent`() {
            val line = """{"message":{"role":"assistant","content":"hi","usage":{"input_tokens":10}}}"""
            TranscriptReader.parseTranscriptLine(line, 0)!!.usage!!.model shouldBe ""
        }

        @Test
        fun `assistant without usage has null usage`() {
            val line = """{"message":{"role":"assistant","content":"hi"}}"""
            TranscriptReader.parseTranscriptLine(line, 0)!!.usage shouldBe null
        }

        @Test
        fun `user message has null usage`() {
            val line = """{"message":{"role":"user","content":"do the thing"}}"""
            TranscriptReader.parseTranscriptLine(line, 0)!!.usage shouldBe null
        }
    }
}
