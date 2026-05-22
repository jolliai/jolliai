package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class SessionTitleResolverTest {

	@TempDir
	lateinit var tempDir: File

	private fun session(
		sessionId: String = "s1",
		transcriptPath: String = "/tmp/x.jsonl",
		source: TranscriptSource? = TranscriptSource.claude,
		title: String? = null,
	) = SessionInfo(
		sessionId = sessionId,
		transcriptPath = transcriptPath,
		updatedAt = "2026-05-15T00:00:00Z",
		source = source,
		title = title,
	)

	// ── Priority chain ──────────────────────────────────────────────────

	@Nested
	inner class PriorityChain {
		@Test
		fun `pre-populated title short-circuits`() {
			val result = SessionTitleResolver.resolveSessionTitle(session(title = "My Title"))
			result shouldBe "My Title"
		}

		@Test
		fun `pre-populated title is truncated to 60 code points`() {
			val longTitle = "a".repeat(100)
			val result = SessionTitleResolver.resolveSessionTitle(session(title = longTitle))
			result.codePointCount(0, result.length) shouldBe 60
		}

		@Test
		fun `Claude ai-title is extracted from JSONL`() {
			val file = File(tempDir, "transcript.jsonl")
			file.writeText(
				listOf(
					"""{"type":"user","message":{"role":"user","content":"hi"}}""",
					"""{"type":"ai-title","aiTitle":"AI Generated Title"}""",
				).joinToString("\n"),
			)
			val result = SessionTitleResolver.resolveSessionTitle(
				session(transcriptPath = file.absolutePath),
			)
			result shouldBe "AI Generated Title"
		}

		@Test
		fun `falls back to first user message from entries`() {
			val entries = listOf(
				TranscriptEntry("assistant", "I'm an AI"),
				TranscriptEntry("human", "Hello world"),
			)
			val result = SessionTitleResolver.resolveSessionTitle(
				session(transcriptPath = "/nonexistent"),
				entries,
			)
			result shouldBe "Hello world"
		}

		@Test
		fun `returns UNTITLED_SESSION when everything fails`() {
			val result = SessionTitleResolver.resolveSessionTitle(
				session(transcriptPath = "/nonexistent"),
				emptyList(),
			)
			result shouldBe FallbackTitle.UNTITLED_SESSION
		}
	}

	// ── firstUserMessageTitleFromEntries ─────────────────────────────────

	@Nested
	inner class FirstUserMessageFromEntries {
		@Test
		fun `skips assistant entries`() {
			val entries = listOf(
				TranscriptEntry("assistant", "skipped"),
				TranscriptEntry("human", "found"),
			)
			SessionTitleResolver.firstUserMessageTitleFromEntries(entries) shouldBe "found"
		}

		@Test
		fun `skips blank human entries`() {
			val entries = listOf(
				TranscriptEntry("human", "   "),
				TranscriptEntry("human", "actual content"),
			)
			SessionTitleResolver.firstUserMessageTitleFromEntries(entries) shouldBe "actual content"
		}

		@Test
		fun `returns UNTITLED_SESSION for empty list`() {
			SessionTitleResolver.firstUserMessageTitleFromEntries(emptyList()) shouldBe FallbackTitle.UNTITLED_SESSION
		}

		@Test
		fun `truncates long first message`() {
			val entries = listOf(TranscriptEntry("human", "a".repeat(100)))
			val result = SessionTitleResolver.firstUserMessageTitleFromEntries(entries)
			result.codePointCount(0, result.length) shouldBe 60
		}
	}

	// ── Non-Claude sources skip ai-title ────────────────────────────────

	@Nested
	inner class NonClaudeSources {
		@Test
		fun `codex source skips ai-title and uses entries`() {
			val entries = listOf(TranscriptEntry("human", "codex prompt"))
			val result = SessionTitleResolver.resolveSessionTitle(
				session(source = TranscriptSource.codex, transcriptPath = "/nonexistent"),
				entries,
			)
			result shouldBe "codex prompt"
		}

		@Test
		fun `opencode source with native title returns it`() {
			val result = SessionTitleResolver.resolveSessionTitle(
				session(source = TranscriptSource.opencode, title = "OC Title"),
			)
			result shouldBe "OC Title"
		}
	}
}
