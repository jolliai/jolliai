package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class TranscriptParsersTest {

    // ── ClaudeTranscriptParser ──────────────────────────────────────────

    @Nested
    inner class ClaudeTranscriptParserTest {
        private val parser = ClaudeTranscriptParser()

        @Test
        fun `parses user message`() {
            val line = """{"message":{"role":"user","content":"Hello Claude"}}"""
            val entry = parser.parseLine(line, 0)
            entry shouldNotBe null
            entry!!.role shouldBe "human"
            entry.content shouldBe "Hello Claude"
        }

        @Test
        fun `returns null for invalid JSON`() {
            parser.parseLine("not json", 0) shouldBe null
        }
    }

    // ── CodexTranscriptParser ───────────────────────────────────────────

    @Nested
    inner class CodexTranscriptParserTest {
        private val parser = CodexTranscriptParser()

        @Test
        fun `parses user_message type`() {
            val line = """{"type":"event_msg","payload":{"type":"user_message","message":"Hello"},"timestamp":"2026-01-01T00:00:00Z"}"""
            val entry = parser.parseLine(line, 0)
            entry shouldNotBe null
            entry!!.role shouldBe "human"
            entry.content shouldBe "Hello"
        }

        @Test
        fun `parses agent_message type`() {
            val line = """{"type":"event_msg","payload":{"type":"agent_message","message":"Response"},"timestamp":"2026-01-01T00:00:00Z"}"""
            val entry = parser.parseLine(line, 0)
            entry shouldNotBe null
            entry!!.role shouldBe "assistant"
            entry.content shouldBe "Response"
        }

        @Test
        fun `returns null for non-event_msg type`() {
            val line = """{"type":"other","payload":{"type":"user_message","message":"Hello"}}"""
            parser.parseLine(line, 0) shouldBe null
        }

        @Test
        fun `returns null for unknown payload type`() {
            val line = """{"type":"event_msg","payload":{"type":"system","message":"Hello"}}"""
            parser.parseLine(line, 0) shouldBe null
        }

        @Test
        fun `returns null for empty message`() {
            val line = """{"type":"event_msg","payload":{"type":"user_message","message":""}}"""
            parser.parseLine(line, 0) shouldBe null
        }

        @Test
        fun `returns null for invalid JSON`() {
            parser.parseLine("bad json", 0) shouldBe null
        }

        @Test
        fun `returns null for missing payload`() {
            val line = """{"type":"event_msg"}"""
            parser.parseLine(line, 0) shouldBe null
        }
    }

    // ── getParserForSource ──────────────────────────────────────────────

    @Nested
    inner class GetParserForSourceTest {
        @Test
        fun `returns CodexTranscriptParser for codex`() {
            val parser = getParserForSource(TranscriptSource.codex)
            parser::class shouldBe CodexTranscriptParser::class
        }

        @Test
        fun `returns ClaudeTranscriptParser for claude`() {
            val parser = getParserForSource(TranscriptSource.claude)
            parser::class shouldBe ClaudeTranscriptParser::class
        }

        @Test
        fun `returns ClaudeTranscriptParser for gemini`() {
            val parser = getParserForSource(TranscriptSource.gemini)
            parser::class shouldBe ClaudeTranscriptParser::class
        }
    }
}
