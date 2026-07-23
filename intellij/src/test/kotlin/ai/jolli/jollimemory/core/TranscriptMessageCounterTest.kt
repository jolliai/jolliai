package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldHaveSize
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class TranscriptMessageCounterTest {

	@TempDir
	lateinit var tempDir: File

	private val cwd get() = tempDir.absolutePath

	@BeforeEach
	fun setUp() {
		File(tempDir, ".jolli/jollimemory").mkdirs()
	}

	private fun writeClaudeTranscript(name: String, vararg lines: String): String {
		val file = File(tempDir, name)
		file.writeText(lines.joinToString("\n") + "\n")
		return file.absolutePath
	}

	// ── loadUnreadTranscript ────────────────────────────────────────────

	@Nested
	inner class LoadUnreadTranscript {
		@Test
		fun `returns all entries when no projectDir`() {
			val path = writeClaudeTranscript(
				"c.jsonl",
				"""{"type":"user","message":{"role":"user","content":"hi"}}""",
			)
			val entries = TranscriptMessageCounter.loadUnreadTranscript(
				TranscriptSource.claude, path, null,
			)
			entries shouldHaveSize 1
		}

		@Test
		fun `returns empty on error`() {
			val entries = TranscriptMessageCounter.loadUnreadTranscript(
				TranscriptSource.claude, "/nonexistent", cwd,
			)
			entries.shouldBeEmpty()
		}
	}
}
