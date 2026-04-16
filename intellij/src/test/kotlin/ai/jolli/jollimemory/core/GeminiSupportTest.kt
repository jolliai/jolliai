package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class GeminiSupportTest {

    @Nested
    inner class ReadGeminiTranscript {
        @Test
        fun `parses valid Gemini JSON transcript`(@TempDir tempDir: File) {
            val file = File(tempDir, "session.json")
            file.writeText("""
{
  "messages": [
    {"role": "user", "content": "Hello Gemini"},
    {"role": "model", "content": "Hi there!"},
    {"role": "user", "content": "How are you?"},
    {"role": "assistant", "content": "I'm doing well"}
  ]
}
            """.trimIndent())

            val entries = GeminiSupport.readGeminiTranscript(file.absolutePath)
            entries shouldHaveSize 4
            entries[0] shouldBe TranscriptEntry("human", "Hello Gemini")
            entries[1] shouldBe TranscriptEntry("assistant", "Hi there!")
            entries[2] shouldBe TranscriptEntry("human", "How are you?")
            entries[3] shouldBe TranscriptEntry("assistant", "I'm doing well")
        }

        @Test
        fun `returns empty for nonexistent file`() {
            GeminiSupport.readGeminiTranscript("/nonexistent/file.json").shouldBeEmpty()
        }

        @Test
        fun `returns empty for invalid JSON`(@TempDir tempDir: File) {
            val file = File(tempDir, "bad.json")
            file.writeText("not json")
            GeminiSupport.readGeminiTranscript(file.absolutePath).shouldBeEmpty()
        }

        @Test
        fun `skips messages with unknown roles`(@TempDir tempDir: File) {
            val file = File(tempDir, "session.json")
            file.writeText("""
{
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hello"}
  ]
}
            """.trimIndent())

            val entries = GeminiSupport.readGeminiTranscript(file.absolutePath)
            entries shouldHaveSize 1
            entries[0].role shouldBe "human"
        }

        @Test
        fun `returns empty for missing messages array`(@TempDir tempDir: File) {
            val file = File(tempDir, "empty.json")
            file.writeText("""{"other": "data"}""")
            GeminiSupport.readGeminiTranscript(file.absolutePath).shouldBeEmpty()
        }
    }
}
