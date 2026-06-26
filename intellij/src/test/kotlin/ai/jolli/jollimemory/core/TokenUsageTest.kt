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
