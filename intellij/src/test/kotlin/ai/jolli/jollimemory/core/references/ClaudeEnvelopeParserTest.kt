package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class ClaudeEnvelopeParserTest {

	private val adapters = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter)

	/** Build a Claude transcript JSONL assistant line with a tool_use block. */
	private fun toolUseLine(
		toolUseId: String,
		name: String,
		input: String = "{}",
		timestamp: String = "2024-01-01T00:00:00Z",
	): String = """{"timestamp":"$timestamp","message":{"role":"assistant","content":[{"type":"tool_use","id":"$toolUseId","name":"$name","input":$input}]}}"""

	/** Build a Claude transcript JSONL user line with a tool_result block. */
	private fun toolResultLine(
		toolUseId: String,
		payloadJson: String,
		timestamp: String = "2024-01-01T00:00:01Z",
		isError: Boolean = false,
	): String {
		val errorField = if (isError) ""","is_error":true""" else ""
		return """{"timestamp":"$timestamp","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"$toolUseId","content":[{"type":"text","text":"$payloadJson"}]$errorField}]}}"""
	}

	private val LINEAR_PAYLOAD = """{"id":"PROJ-42","title":"Test issue","url":"https://linear.app/x/issue/PROJ-42","status":"In Progress"}"""
		.replace("\"", "\\\"")

	@Nested
	inner class BasicPairing {
		@Test
		fun `pairs tool_use with tool_result by id`() {
			val lines = listOf(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe LinearAdapter
			result.results[0].toolName shouldBe "mcp__linear__get_issue"
			result.lastLineNumberScanned shouldBe 2
		}

		@Test
		fun `ignores orphan tool_use with no result`() {
			val lines = listOf(
				toolUseLine("tu1", "mcp__linear__get_issue"),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 0
		}
	}

	@Nested
	inner class Filtering {
		@Test
		fun `skips unknown tool names`() {
			val lines = listOf(
				toolUseLine("tu1", "mcp__slack__send"),
				toolResultLine("tu1", """{}"""),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 0
		}

		@Test
		fun `respects beforeTimestamp`() {
			val lines = listOf(
				toolUseLine("tu1", "mcp__linear__get_issue", timestamp = "2024-01-02T00:00:00Z"),
				toolResultLine("tu1", LINEAR_PAYLOAD, timestamp = "2024-01-02T00:00:01Z"),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(beforeTimestamp = "2024-01-01T00:00:00Z"), adapters)
			result.results.size shouldBe 0
		}

		@Test
		fun `respects fromLineNumber`() {
			val lines = listOf(
				toolUseLine("tu1", "mcp__linear__get_issue"),
				toolResultLine("tu1", LINEAR_PAYLOAD),
				toolUseLine("tu2", "mcp__linear__get_issue"),
				toolResultLine("tu2", LINEAR_PAYLOAD),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(fromLineNumber = 2), adapters)
			result.results.size shouldBe 1
			result.lastLineNumberScanned shouldBe 4
		}
	}

	@Nested
	inner class ShellFallback {
		@Test
		fun `pairs Bash tool_use with gh command to GitHub`() {
			val input = """{"command":"gh issue view 42 --repo o/r --json title,body"}"""
			val ghPayload = """{"number":42,"title":"Fix","html_url":"https://github.com/o/r/issues/42","state":"open","repository":{"full_name":"o/r"}}"""
				.replace("\"", "\\\"")
			val lines = listOf(
				toolUseLine("tu1", "Bash", input),
				toolResultLine("tu1", ghPayload),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe GitHubAdapter
			result.results[0].toolName shouldBe "mcp__github__issue_read"
		}

		@Test
		fun `skips errored CLI result`() {
			val input = """{"command":"gh issue view 42 --repo o/r --json title"}"""
			val lines = listOf(
				toolUseLine("tu1", "Bash", input),
				toolResultLine("tu1", "error output", isError = true),
			)
			val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 0
		}
	}

	@Test
	fun `tolerates blank and malformed lines`() {
		val lines = listOf(
			"",
			"not-json-at-all",
			toolUseLine("tu1", "mcp__linear__get_issue"),
			toolResultLine("tu1", LINEAR_PAYLOAD),
		)
		val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
		result.results.size shouldBe 1
	}
}
