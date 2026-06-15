package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class ReferenceExtractorTest {

	private val adapters = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter)

	private fun toolUseLine(
		toolUseId: String,
		name: String,
		input: String = "{}",
		timestamp: String = "2024-01-01T00:00:00Z",
	): String = """{"timestamp":"$timestamp","message":{"role":"assistant","content":[{"type":"tool_use","id":"$toolUseId","name":"$name","input":$input}]}}"""

	private fun toolResultLine(
		toolUseId: String,
		payloadJson: String,
		timestamp: String = "2024-01-01T00:00:01Z",
	): String {
		val escaped = payloadJson.replace("\"", "\\\"")
		return """{"timestamp":"$timestamp","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"$toolUseId","content":[{"type":"text","text":"$escaped"}]}]}}"""
	}

	private val LINEAR_PAYLOAD = """{"id":"PROJ-42","title":"Test issue","url":"https://linear.app/x/issue/PROJ-42","status":"In Progress"}"""
	private val LINEAR_PAYLOAD_2 = """{"id":"PROJ-99","title":"Another issue","url":"https://linear.app/x/issue/PROJ-99","status":"Done"}"""

	private fun writeTranscript(dir: File, vararg lines: String): String {
		val file = File(dir, "transcript.jsonl")
		file.writeText(lines.joinToString("\n") + "\n")
		return file.absolutePath
	}

	@Nested
	inner class SingleIssue {
		@Test
		fun `extracts a single Linear issue`(@TempDir dir: File) {
			val path = writeTranscript(
				dir,
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters)
			result.references.size shouldBe 1
			result.references[0].mapKey shouldBe "linear:PROJ-42"
			result.references[0].title shouldBe "Test issue"
			result.lastLineNumberScanned shouldBe 2
		}
	}

	@Nested
	inner class MultipleIssues {
		@Test
		fun `extracts multiple different issues`(@TempDir dir: File) {
			val path = writeTranscript(
				dir,
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", LINEAR_PAYLOAD_2),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters)
			result.references.size shouldBe 2
		}
	}

	@Nested
	inner class Deduplication {
		@Test
		fun `deduplicates by mapKey keeping latest referencedAt`(@TempDir dir: File) {
			val path = writeTranscript(
				dir,
				toolUseLine("tu1", "mcp__linear__get_issue", timestamp = "2024-01-01T00:00:00Z"),
				toolResultLine("tu1", LINEAR_PAYLOAD, timestamp = "2024-01-01T00:00:01Z"),
				toolUseLine("tu2", "mcp__linear__get_issue", timestamp = "2024-01-02T00:00:00Z"),
				toolResultLine("tu2", LINEAR_PAYLOAD, timestamp = "2024-01-02T00:00:01Z"),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters)
			result.references.size shouldBe 1
			result.references[0].referencedAt shouldBe "2024-01-02T00:00:01Z"
		}
	}

	@Nested
	inner class WrapperUnwrapping {
		@Test
		fun `unwraps items array`(@TempDir dir: File) {
			val wrapped = """{"items":[${LINEAR_PAYLOAD},${LINEAR_PAYLOAD_2}]}"""
			val path = writeTranscript(
				dir,
				toolUseLine("tu1", "mcp__linear__list_issues"),
				toolResultLine("tu1", wrapped),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters)
			result.references.size shouldBe 2
		}
	}

	@Nested
	inner class EdgeCases {
		@Test
		fun `returns empty for missing file`() {
			val result = ReferenceExtractor.extractFromTranscript("/nonexistent/path.jsonl", adapters)
			result.references.size shouldBe 0
			result.lastLineNumberScanned shouldBe 0
		}

		@Test
		fun `returns empty for empty file`(@TempDir dir: File) {
			val file = File(dir, "empty.jsonl")
			file.writeText("")
			val result = ReferenceExtractor.extractFromTranscript(file.absolutePath, adapters)
			result.references.size shouldBe 0
		}

		@Test
		fun `tolerates malformed JSON lines`(@TempDir dir: File) {
			val path = writeTranscript(
				dir,
				"not json at all",
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters)
			result.references.size shouldBe 1
		}

		@Test
		fun `respects fromLineNumber option`(@TempDir dir: File) {
			val path = writeTranscript(
				dir,
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", LINEAR_PAYLOAD_2),
			)
			val result = ReferenceExtractor.extractFromTranscript(path, adapters, ExtractOptions(fromLineNumber = 2))
			result.references.size shouldBe 1
			result.references[0].mapKey shouldBe "linear:PROJ-99"
		}
	}

	@Nested
	inner class CodexSource {
		@Test
		fun `extracts from Codex transcript`(@TempDir dir: File) {
			val lines = listOf(
				"""{"timestamp":"2024-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"c1","namespace":"mcp__codex_apps__linear","name":"_fetch"}}""",
				"""{"timestamp":"2024-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"c1","output":"[{\"type\":\"text\",\"text\":\"${LINEAR_PAYLOAD.replace("\"", "\\\"")}\"}]"}}""",
			)
			val file = File(dir, "transcript.jsonl")
			file.writeText(lines.joinToString("\n") + "\n")
			val result = ReferenceExtractor.extractFromTranscript(
				file.absolutePath, adapters,
				ExtractOptions(source = ai.jolli.jollimemory.core.TranscriptSource.codex)
			)
			result.references.size shouldBe 1
			result.references[0].mapKey shouldBe "linear:PROJ-42"
		}
	}
}
