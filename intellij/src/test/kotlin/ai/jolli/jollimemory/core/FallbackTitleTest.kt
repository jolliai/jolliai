package ai.jolli.jollimemory.core

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class FallbackTitleTest {

	// ── truncateToCodePoints ─────────────────────────────────────────────

	@Nested
	inner class TruncateToCodePoints {
		@Test
		fun `returns input unchanged when under limit`() {
			FallbackTitle.truncateToCodePoints("hello world", 60) shouldBe "hello world"
		}

		@Test
		fun `truncates at code-point boundary`() {
			val input = "a".repeat(100)
			val result = FallbackTitle.truncateToCodePoints(input, 60)
			result.length shouldBe 60
		}

		@Test
		fun `preserves surrogate pairs`() {
			// U+1F600 (grinning face) is a surrogate pair in UTF-16
			val emoji = "\uD83D\uDE00" // 1 code point, 2 chars
			val input = emoji.repeat(70)
			val result = FallbackTitle.truncateToCodePoints(input, 60)
			result.codePointCount(0, result.length) shouldBe 60
			// Should not break a surrogate pair
			result.length shouldBe 120 // 60 code points * 2 chars each
		}

		@Test
		fun `collapses internal whitespace`() {
			FallbackTitle.truncateToCodePoints("hello   world\t\tfoo", 60) shouldBe "hello world foo"
		}

		@Test
		fun `trims leading and trailing whitespace`() {
			FallbackTitle.truncateToCodePoints("  hello  ", 60) shouldBe "hello"
		}
	}

	// ── readFirstUserMessageTitle ────────────────────────────────────────

	@Nested
	inner class ReadFirstUserMessageTitle {
		@TempDir
		lateinit var tempDir: File

		@Test
		fun `returns UNTITLED_SESSION for missing file`() {
			val result = FallbackTitle.readFirstUserMessageTitle(
				File(tempDir, "missing.jsonl").absolutePath,
			) { null }
			result shouldBe FallbackTitle.UNTITLED_SESSION
		}

		@Test
		fun `returns first parsed user message truncated`() {
			val file = File(tempDir, "test.jsonl")
			file.writeText("line1\nline2\nline3\n")
			val result = FallbackTitle.readFirstUserMessageTitle(file.absolutePath) { line ->
				if (line == "line2") "This is the user message" else null
			}
			result shouldBe "This is the user message"
		}

		@Test
		fun `returns UNTITLED_SESSION when no lines match`() {
			val file = File(tempDir, "test.jsonl")
			file.writeText("line1\nline2\n")
			val result = FallbackTitle.readFirstUserMessageTitle(file.absolutePath) { null }
			result shouldBe FallbackTitle.UNTITLED_SESSION
		}

		@Test
		fun `skips blank lines`() {
			val file = File(tempDir, "test.jsonl")
			file.writeText("\n\n  \nmatch\n")
			val result = FallbackTitle.readFirstUserMessageTitle(file.absolutePath) { "found: $it" }
			result shouldBe "found: match"
		}

		@Test
		fun `truncates long first message to 60 code points`() {
			val file = File(tempDir, "test.jsonl")
			file.writeText("x\n")
			val longMessage = "a".repeat(100)
			val result = FallbackTitle.readFirstUserMessageTitle(file.absolutePath) { longMessage }
			result.codePointCount(0, result.length) shouldBe 60
		}
	}
}
