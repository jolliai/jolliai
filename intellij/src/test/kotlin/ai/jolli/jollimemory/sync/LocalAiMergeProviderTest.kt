package ai.jolli.jollimemory.sync

import org.junit.jupiter.api.Assertions.*
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class LocalAiMergeProviderTest {

	// ── buildPrompt ────────────────────────────────────────────────────

	@Test
	fun `buildPrompt includes markers with token`() {
		val req = AiMergeRequest("file.md", "base", "ours", "theirs", "md")
		val prompt = buildPrompt(req, "abc123")
		assertTrue(prompt.contains("BEGIN_MERGED_abc123"))
		assertTrue(prompt.contains("END_MERGED_abc123"))
		assertTrue(prompt.contains("CONFIDENCE="))
		assertTrue(prompt.contains("file.md"))
	}

	@Test
	fun `buildPrompt handles null base`() {
		val req = AiMergeRequest("file.json", null, "ours", "theirs", "json")
		val prompt = buildPrompt(req, "token")
		assertTrue(prompt.contains("no common ancestor"))
		assertTrue(prompt.contains("valid JSON"))
	}

	@Test
	fun `buildPrompt includes base when present`() {
		val req = AiMergeRequest("file.md", "base content", "ours", "theirs", "md")
		val prompt = buildPrompt(req, "token")
		assertTrue(prompt.contains("base content"))
		assertTrue(prompt.contains("BASE:"))
	}

	// ── parseModelOutput ───────────────────────────────────────────────

	@Test
	fun `parseModelOutput extracts body and confidence`() {
		val text = """
CONFIDENCE=0.85
BEGIN_MERGED_token123
merged content here
line two
END_MERGED_token123
""".trimIndent()
		val result = parseModelOutput(text, "token123")
		assertEquals(0.85, result.confidence, 0.001)
		assertEquals("merged content here\nline two", result.merged)
	}

	@Test
	fun `parseModelOutput clamps confidence to 0-1`() {
		val text = "CONFIDENCE=1.50\nBEGIN_MERGED_t\nbody\nEND_MERGED_t"
		val result = parseModelOutput(text, "t")
		assertEquals(1.0, result.confidence, 0.001)

		val text2 = "CONFIDENCE=-0.5\nBEGIN_MERGED_t\nbody\nEND_MERGED_t"
		val result2 = parseModelOutput(text2, "t")
		assertEquals(0.0, result2.confidence, 0.001)
	}

	@Test
	fun `parseModelOutput tolerates trimmed marker lines`() {
		val text = "CONFIDENCE=0.90\n  BEGIN_MERGED_tok  \nthe body\n  END_MERGED_tok  "
		val result = parseModelOutput(text, "tok")
		assertEquals("the body", result.merged)
	}

	@Test
	fun `parseModelOutput throws on missing confidence`() {
		val text = "NO_CONFIDENCE\nBEGIN_MERGED_t\nbody\nEND_MERGED_t"
		assertThrows<RuntimeException> { parseModelOutput(text, "t") }
	}

	@Test
	fun `parseModelOutput throws on missing markers`() {
		val text = "CONFIDENCE=0.5\nno markers here"
		assertThrows<RuntimeException> { parseModelOutput(text, "t") }
	}

	@Test
	fun `parseModelOutput throws on too-short response`() {
		assertThrows<RuntimeException> { parseModelOutput("short", "t") }
	}

	@Test
	fun `parseModelOutput uses first end marker`() {
		val text = "CONFIDENCE=0.9\nBEGIN_MERGED_t\nreal body\nEND_MERGED_t\nextra\nEND_MERGED_t"
		val result = parseModelOutput(text, "t")
		assertEquals("real body", result.merged)
	}

	@Test
	fun `parseModelOutput rejects wrong token`() {
		val text = "CONFIDENCE=0.9\nBEGIN_MERGED_wrong\nbody\nEND_MERGED_wrong"
		assertThrows<RuntimeException> { parseModelOutput(text, "correct") }
	}
}
