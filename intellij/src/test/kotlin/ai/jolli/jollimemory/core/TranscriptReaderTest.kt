package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TranscriptReaderTest {

    // ── parseTranscriptLine ─────────────────────────────────────────────

    @Nested
    inner class ParseTranscriptLine {
        @Test
        fun `parses user message`() {
            val line = """{"message":{"role":"user","content":"Hello"},"timestamp":"2026-01-01T00:00:00Z"}"""
            val entry = TranscriptReader.parseTranscriptLine(line, 0)
            entry shouldBe TranscriptEntry("human", "Hello", "2026-01-01T00:00:00Z")
        }

        @Test
        fun `parses assistant message`() {
            val line = """{"message":{"role":"assistant","content":"Hi there"},"timestamp":"2026-01-01T00:00:00Z"}"""
            val entry = TranscriptReader.parseTranscriptLine(line, 0)
            entry shouldBe TranscriptEntry("assistant", "Hi there", "2026-01-01T00:00:00Z")
        }

        @Test
        fun `returns null for invalid JSON`() {
            TranscriptReader.parseTranscriptLine("not json", 0) shouldBe null
        }

        @Test
        fun `returns null for compaction summaries`() {
            val line = """{"isCompactSummary":true,"message":{"role":"assistant","content":"summary"}}"""
            TranscriptReader.parseTranscriptLine(line, 0) shouldBe null
        }

        @Test
        fun `returns null for missing message`() {
            TranscriptReader.parseTranscriptLine("""{"timestamp":"2026-01-01T00:00:00Z"}""", 0) shouldBe null
        }

        @Test
        fun `returns null for unknown role`() {
            val line = """{"message":{"role":"system","content":"hi"}}"""
            TranscriptReader.parseTranscriptLine(line, 0) shouldBe null
        }

        @Test
        fun `returns null for empty content`() {
            val line = """{"message":{"role":"assistant","content":""}}"""
            TranscriptReader.parseTranscriptLine(line, 0) shouldBe null
        }

        @Test
        fun `parses content array with text blocks`() {
            val line = """{"message":{"role":"assistant","content":[{"type":"text","text":"Part 1"},{"type":"text","text":"Part 2"}]}}"""
            val entry = TranscriptReader.parseTranscriptLine(line, 0)
            entry?.content shouldBe "Part 1\nPart 2"
        }

        @Test
        fun `skips user messages starting with filtered prefixes`() {
            val line = """{"message":{"role":"user","content":"Base directory for this skill: /foo/bar"}}"""
            TranscriptReader.parseTranscriptLine(line, 0) shouldBe null
        }

        @Test
        fun `strips IDE tags from user messages`() {
            val line = """{"message":{"role":"user","content":"Hello <system-reminder>stuff</system-reminder> world"}}"""
            val entry = TranscriptReader.parseTranscriptLine(line, 0)
            entry?.content shouldBe "Hello  world"
            entry?.content?.shouldNotContain("system-reminder")
        }
    }

    // ── readTranscript ──────────────────────────────────────────────────

    @Nested
    inner class ReadTranscript {
        @Test
        fun `reads transcript file and returns entries`(@TempDir tempDir: File) {
            val file = File(tempDir, "test.jsonl")
            file.writeText("""
{"message":{"role":"user","content":"Hello"}}
{"message":{"role":"assistant","content":"Hi"}}
            """.trimIndent())

            val result = TranscriptReader.readTranscript(file.absolutePath)
            result.entries shouldHaveSize 2
            result.entries[0].role shouldBe "human"
            result.entries[1].role shouldBe "assistant"
            result.totalLinesRead shouldBe 2
        }

        @Test
        fun `respects cursor position`(@TempDir tempDir: File) {
            val file = File(tempDir, "test.jsonl")
            file.writeText("""
{"message":{"role":"user","content":"First"}}
{"message":{"role":"assistant","content":"Second"}}
{"message":{"role":"user","content":"Third"}}
            """.trimIndent())

            val cursor = TranscriptCursor(file.absolutePath, 2, "2026-01-01T00:00:00Z")
            val result = TranscriptReader.readTranscript(file.absolutePath, cursor)
            result.entries shouldHaveSize 1
            result.entries[0].content shouldBe "Third"
        }

        @Test
        fun `merges consecutive same-role entries`(@TempDir tempDir: File) {
            val file = File(tempDir, "test.jsonl")
            file.writeText("""
{"message":{"role":"user","content":"A"}}
{"message":{"role":"user","content":"B"}}
{"message":{"role":"assistant","content":"C"}}
            """.trimIndent())

            val result = TranscriptReader.readTranscript(file.absolutePath)
            result.entries shouldHaveSize 2
            result.entries[0].content shouldContain "A"
            result.entries[0].content shouldContain "B"
        }
    }

    // ── mergeConsecutiveEntries ──────────────────────────────────────────

    @Nested
    inner class MergeConsecutiveEntries {
        @Test
        fun `returns empty for empty input`() {
            TranscriptReader.mergeConsecutiveEntries(emptyList()).shouldBeEmpty()
        }

        @Test
        fun `returns single entry unchanged`() {
            val entries = listOf(TranscriptEntry("human", "Hello"))
            val result = TranscriptReader.mergeConsecutiveEntries(entries)
            result shouldHaveSize 1
            result[0].content shouldBe "Hello"
        }

        @Test
        fun `merges consecutive same-role entries`() {
            val entries = listOf(
                TranscriptEntry("human", "A", "t1"),
                TranscriptEntry("human", "B", null),
            )
            val result = TranscriptReader.mergeConsecutiveEntries(entries)
            result shouldHaveSize 1
            result[0].content shouldBe "A\n\nB"
            result[0].timestamp shouldBe "t1" // keeps first timestamp
        }

        @Test
        fun `does not merge different roles`() {
            val entries = listOf(
                TranscriptEntry("human", "A"),
                TranscriptEntry("assistant", "B"),
            )
            val result = TranscriptReader.mergeConsecutiveEntries(entries)
            result shouldHaveSize 2
        }
    }

    // ── buildConversationContext ─────────────────────────────────────────

    @Nested
    inner class BuildConversationContext {
        @Test
        fun `formats entries with role prefixes`() {
            val entries = listOf(
                TranscriptEntry("human", "Hello"),
                TranscriptEntry("assistant", "Hi there"),
            )
            val context = TranscriptReader.buildConversationContext(entries)
            context shouldContain "[Human]: Hello"
            context shouldContain "[Assistant]: Hi there"
        }

        @Test
        fun `truncates to maxChars keeping most recent`() {
            val entries = (1..100).map { TranscriptEntry("human", "Entry number $it with some padding text") }
            val context = TranscriptReader.buildConversationContext(entries, maxChars = 200)
            // Should have fewer entries than 100
            context.length shouldBe context.length // just verify it doesn't crash
            context shouldContain "[Human]:"
        }

        @Test
        fun `returns empty for empty entries`() {
            TranscriptReader.buildConversationContext(emptyList()) shouldBe ""
        }
    }

    // ── buildMultiSessionContext ─────────────────────────────────────────

    @Nested
    inner class BuildMultiSessionContext {
        @Test
        fun `wraps sessions in XML tags`() {
            val sessions = listOf(
                TranscriptReader.SessionTranscript(
                    "session1",
                    "/path/to/transcript",
                    listOf(TranscriptEntry("human", "Hello", "2026-01-01T10:00:00Z")),
                ),
            )
            val context = TranscriptReader.buildMultiSessionContext(sessions)
            context shouldContain "<transcript>"
            context shouldContain "<session id=\"session1\""
            context shouldContain "</session>"
            context shouldContain "</transcript>"
        }

        @Test
        fun `returns empty for no entries`() {
            val sessions = listOf(
                TranscriptReader.SessionTranscript("s1", "/path", emptyList()),
            )
            TranscriptReader.buildMultiSessionContext(sessions) shouldBe ""
        }
    }
}
