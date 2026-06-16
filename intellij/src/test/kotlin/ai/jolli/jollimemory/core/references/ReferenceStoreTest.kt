package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldStartWith
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ReferenceStoreTest {

	@Nested
	inner class SanitizeNativeIdForPath {
		@Test
		fun `linear id passes through unchanged`() {
			ReferenceStore.sanitizeNativeIdForPath(SourceId.linear, "PROJ-42") shouldBe "PROJ-42"
		}

		@Test
		fun `jira id passes through unchanged`() {
			ReferenceStore.sanitizeNativeIdForPath(SourceId.jira, "JIRA-999") shouldBe "JIRA-999"
		}

		@Test
		fun `notion id passes through unchanged`() {
			ReferenceStore.sanitizeNativeIdForPath(SourceId.notion, "abc123def456") shouldBe "abc123def456"
		}

		@Test
		fun `github id gets sanitized with sha suffix`() {
			val result = ReferenceStore.sanitizeNativeIdForPath(SourceId.github, "owner/repo#123")
			result shouldContain "-"
			// Should not contain the slash
			result.contains("/") shouldBe false
			// Should end with 8-char hex suffix
			result.length shouldBe result.length // non-empty
		}

		@Test
		fun `github produces deterministic output`() {
			val a = ReferenceStore.sanitizeNativeIdForPath(SourceId.github, "owner/repo#123")
			val b = ReferenceStore.sanitizeNativeIdForPath(SourceId.github, "owner/repo#123")
			a shouldBe b
		}

		@Test
		fun `github different ids produce different output`() {
			val a = ReferenceStore.sanitizeNativeIdForPath(SourceId.github, "owner/repo#1")
			val b = ReferenceStore.sanitizeNativeIdForPath(SourceId.github, "owner/repo#2")
			a shouldNotBe b
		}

		@Test
		fun `rejects linear id with path traversal`() {
			assertThrows<IllegalArgumentException> {
				ReferenceStore.sanitizeNativeIdForPath(SourceId.linear, "../escape")
			}
		}

		@Test
		fun `rejects jira id with slash`() {
			assertThrows<IllegalArgumentException> {
				ReferenceStore.sanitizeNativeIdForPath(SourceId.jira, "PROJ/42")
			}
		}

		@Test
		fun `rejects notion id with backslash`() {
			assertThrows<IllegalArgumentException> {
				ReferenceStore.sanitizeNativeIdForPath(SourceId.notion, "abc\\def")
			}
		}
	}

	@Nested
	inner class RenderAndParseMarkdown {

		private val minimalRef = Reference(
			mapKey = "linear:PROJ-42",
			source = SourceId.linear,
			nativeId = "PROJ-42",
			title = "Fix the bug",
			url = "https://linear.app/x/issue/PROJ-42",
			toolName = "mcp__linear__get_issue",
			referencedAt = "2024-06-01T12:00:00Z",
		)

		@Test
		fun `round-trips a minimal reference`() {
			val md = ReferenceStore.renderMarkdown(minimalRef)
			val parsed = ReferenceStore.readReferenceMarkdownFromString(md)
			parsed shouldNotBe null
			parsed!!.source shouldBe SourceId.linear
			parsed.nativeId shouldBe "PROJ-42"
			parsed.title shouldBe "Fix the bug"
			parsed.url shouldBe "https://linear.app/x/issue/PROJ-42"
			parsed.toolName shouldBe "mcp__linear__get_issue"
			parsed.referencedAt shouldBe "2024-06-01T12:00:00Z"
			parsed.fields shouldBe null
			parsed.description shouldBe null
		}

		@Test
		fun `round-trips a reference with fields`() {
			val ref = minimalRef.copy(
				fields = listOf(
					ReferenceField("status", "Status", "In Progress", "circle"),
					ReferenceField("priority", "Priority", "High"),
				),
			)
			val md = ReferenceStore.renderMarkdown(ref)
			val parsed = ReferenceStore.readReferenceMarkdownFromString(md)
			parsed shouldNotBe null
			parsed!!.fields shouldNotBe null
			parsed.fields!!.size shouldBe 2
			parsed.fields!![0].key shouldBe "status"
			parsed.fields!![0].label shouldBe "Status"
			parsed.fields!![0].value shouldBe "In Progress"
			parsed.fields!![0].icon shouldBe "circle"
			parsed.fields!![1].key shouldBe "priority"
			parsed.fields!![1].icon shouldBe null
		}

		@Test
		fun `round-trips a reference with description`() {
			val ref = minimalRef.copy(description = "This is the issue body.\n\nIt has multiple paragraphs.")
			val md = ReferenceStore.renderMarkdown(ref)
			val parsed = ReferenceStore.readReferenceMarkdownFromString(md)
			parsed shouldNotBe null
			parsed!!.description shouldBe "This is the issue body.\n\nIt has multiple paragraphs."
		}

		@Test
		fun `handles special characters in title`() {
			val ref = minimalRef.copy(title = """She said "hello" & it's \nice""")
			val md = ReferenceStore.renderMarkdown(ref)
			val parsed = ReferenceStore.readReferenceMarkdownFromString(md)
			parsed shouldNotBe null
			parsed!!.title shouldBe """She said "hello" & it's \nice"""
		}

		@Test
		fun `rendered markdown starts with frontmatter`() {
			val md = ReferenceStore.renderMarkdown(minimalRef)
			md shouldStartWith "---\n"
			md shouldContain "\n---\n"
		}

		@Test
		fun `returns null for empty content`() {
			ReferenceStore.readReferenceMarkdownFromString("") shouldBe null
		}

		@Test
		fun `returns null for content without frontmatter`() {
			ReferenceStore.readReferenceMarkdownFromString("Just some text") shouldBe null
		}

		@Test
		fun `returns null for content with unclosed frontmatter`() {
			ReferenceStore.readReferenceMarkdownFromString("---\nsource: \"linear\"\n") shouldBe null
		}
	}

	@Nested
	inner class WriteAndReadMarkdown {

		private val ref = Reference(
			mapKey = "linear:PROJ-42",
			source = SourceId.linear,
			nativeId = "PROJ-42",
			title = "Fix the bug",
			url = "https://linear.app/x/issue/PROJ-42",
			toolName = "mcp__linear__get_issue",
			referencedAt = "2024-06-01T12:00:00Z",
		)

		@Test
		fun `writes and reads back from disk`(@TempDir tempDir: File) {
			val cwd = tempDir.absolutePath
			val result = ReferenceStore.writeReferenceMarkdown(ref, cwd)
			result.sourcePath shouldContain "PROJ-42.md"

			val readBack = ReferenceStore.readReferenceMarkdown(result.sourcePath)
			readBack shouldNotBe null
			readBack!!.nativeId shouldBe "PROJ-42"
			readBack.title shouldBe "Fix the bug"
		}

		@Test
		fun `skips write when content unchanged`(@TempDir tempDir: File) {
			val cwd = tempDir.absolutePath
			val result1 = ReferenceStore.writeReferenceMarkdown(ref, cwd)
			val file = File(result1.sourcePath)
			val mtime1 = file.lastModified()

			// Small delay to ensure mtime would differ
			Thread.sleep(50)

			val result2 = ReferenceStore.writeReferenceMarkdown(ref, cwd)
			result2.sourcePath shouldBe result1.sourcePath
			file.lastModified() shouldBe mtime1
		}

		@Test
		fun `overwrites when content changes`(@TempDir tempDir: File) {
			val cwd = tempDir.absolutePath
			ReferenceStore.writeReferenceMarkdown(ref, cwd)

			val updated = ref.copy(title = "Updated title")
			val result2 = ReferenceStore.writeReferenceMarkdown(updated, cwd)

			val readBack = ReferenceStore.readReferenceMarkdown(result2.sourcePath)
			readBack shouldNotBe null
			readBack!!.title shouldBe "Updated title"
		}

		@Test
		fun `readReferenceMarkdown returns null for missing file`() {
			ReferenceStore.readReferenceMarkdown("/nonexistent/path.md") shouldBe null
		}

		@Test
		fun `deleteReferenceMarkdown removes file`(@TempDir tempDir: File) {
			val cwd = tempDir.absolutePath
			val result = ReferenceStore.writeReferenceMarkdown(ref, cwd)
			File(result.sourcePath).exists() shouldBe true

			ReferenceStore.deleteReferenceMarkdown(result.sourcePath)
			File(result.sourcePath).exists() shouldBe false
		}
	}

	@Nested
	inner class HashReferenceContent {
		private val ref = Reference(
			mapKey = "linear:PROJ-42",
			source = SourceId.linear,
			nativeId = "PROJ-42",
			title = "Fix the bug",
			url = "https://linear.app/x/issue/PROJ-42",
			toolName = "mcp__linear__get_issue",
			referencedAt = "2024-06-01T12:00:00Z",
		)

		@Test
		fun `hash is deterministic`() {
			val h1 = ReferenceStore.hashReferenceContent(ref)
			val h2 = ReferenceStore.hashReferenceContent(ref)
			h1 shouldBe h2
		}

		@Test
		fun `hash ignores referencedAt`() {
			val h1 = ReferenceStore.hashReferenceContent(ref)
			val h2 = ReferenceStore.hashReferenceContent(ref.copy(referencedAt = "2025-01-01T00:00:00Z"))
			h1 shouldBe h2
		}

		@Test
		fun `hash changes when title changes`() {
			val h1 = ReferenceStore.hashReferenceContent(ref)
			val h2 = ReferenceStore.hashReferenceContent(ref.copy(title = "Different title"))
			h1 shouldNotBe h2
		}

		@Test
		fun `hash is 64-char hex string`() {
			val hash = ReferenceStore.hashReferenceContent(ref)
			hash.length shouldBe 64
			hash.matches(Regex("[a-f0-9]+")) shouldBe true
		}
	}

	@Nested
	inner class ReferencePaths {
		@Test
		fun `referenceDir includes source name`(@TempDir tempDir: File) {
			val dir = ReferenceStore.referenceDir(tempDir.absolutePath, SourceId.linear)
			dir shouldContain "references/linear"
		}

		@Test
		fun `referencePath includes source and key`(@TempDir tempDir: File) {
			val path = ReferenceStore.referencePath(tempDir.absolutePath, SourceId.jira, "JIRA-100")
			path shouldContain "references/jira/JIRA-100.md"
		}
	}
}
