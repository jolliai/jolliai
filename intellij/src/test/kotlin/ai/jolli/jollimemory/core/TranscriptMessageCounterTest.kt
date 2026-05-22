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

	// ── loadMergedTranscript ────────────────────────────────────────────

	@Nested
	inner class LoadMergedTranscript {
		@Test
		fun `loads claude transcript entries`() {
			val path = writeClaudeTranscript(
				"c.jsonl",
				"""{"type":"user","message":{"role":"user","content":"hi"}}""",
				"""{"type":"assistant","message":{"role":"assistant","content":"hello"}}""",
			)
			val session = SessionInfo("s1", path, "2026-05-15T00:00:00Z")
			val entries = TranscriptMessageCounter.loadMergedTranscript(session)
			entries shouldHaveSize 2
		}

		@Test
		fun `applies overlay when projectDir is provided`() {
			val path = writeClaudeTranscript(
				"c.jsonl",
				"""{"type":"user","message":{"role":"user","content":"delete me"}}""",
				"""{"type":"assistant","message":{"role":"assistant","content":"keep me"}}""",
			)
			val session = SessionInfo("s1", path, "2026-05-15T00:00:00Z")

			// Save an overlay that deletes the user entry
			val key = ConversationOverlayStore.OverlayKey(cwd, TranscriptSource.claude, "s1")
			ConversationOverlayStore.saveOverlay(
				key,
				listOf(ConversationOverlayStore.EntryIdentity("human", "delete me")),
				emptyList(),
			)

			val entries = TranscriptMessageCounter.loadMergedTranscript(session, cwd)
			entries shouldHaveSize 1
			entries[0].content shouldBe "keep me"
		}

		@Test
		fun `no overlay returns raw entries`() {
			val path = writeClaudeTranscript(
				"c.jsonl",
				"""{"type":"user","message":{"role":"user","content":"hi"}}""",
			)
			val session = SessionInfo("s1", path, "2026-05-15T00:00:00Z")
			val entries = TranscriptMessageCounter.loadMergedTranscript(session, cwd)
			entries shouldHaveSize 1
		}
	}

	// ── countTranscriptMessages ─────────────────────────────────────────

	@Nested
	inner class CountTranscriptMessages {
		@Test
		fun `returns correct count`() {
			val path = writeClaudeTranscript(
				"c.jsonl",
				"""{"type":"user","message":{"role":"user","content":"a"}}""",
				"""{"type":"assistant","message":{"role":"assistant","content":"b"}}""",
				"""{"type":"user","message":{"role":"user","content":"c"}}""",
			)
			val session = SessionInfo("s1", path, "2026-05-15T00:00:00Z")
			TranscriptMessageCounter.countTranscriptMessages(session) shouldBe 3
		}

		@Test
		fun `returns 0 when file does not exist`() {
			val session = SessionInfo("s1", "/nonexistent/file.jsonl", "2026-05-15T00:00:00Z")
			TranscriptMessageCounter.countTranscriptMessages(session) shouldBe 0
		}
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
