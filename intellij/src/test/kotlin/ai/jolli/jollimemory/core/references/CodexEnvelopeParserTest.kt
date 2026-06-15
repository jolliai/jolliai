package ai.jolli.jollimemory.core.references

import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CodexEnvelopeParserTest {

	private val adapters = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter)

	private fun fnCall(namespace: String, name: String, callId: String, timestamp: String = "2024-01-01T00:00:00Z"): String =
		"""{"timestamp":"$timestamp","payload":{"type":"function_call","call_id":"$callId","namespace":"$namespace","name":"$name"}}"""

	private fun fnOutput(callId: String, inner: String, timestamp: String = "2024-01-01T00:00:01Z", prefix: String = ""): String {
		val wrapped = """[{"type":"text","text":"${inner.replace("\"", "\\\"")}"}]"""
		val output = if (prefix.isEmpty()) wrapped else "$prefix\nOutput:\n$wrapped"
		val escaped = output.replace("\"", "\\\"").replace("\n", "\\n")
		return """{"timestamp":"$timestamp","payload":{"type":"function_call_output","call_id":"$callId","output":"$escaped"}}"""
	}

	private fun toolCallEnd(tool: String, callId: String?, inner: String, timestamp: String = "2024-01-01T00:00:01Z"): String {
		val callIdField = if (callId != null) """"call_id":"$callId",""" else ""
		return """{"timestamp":"$timestamp","payload":{"type":"mcp_tool_call_end",$callIdField"invocation":{"tool":"$tool"},"result":{"Ok":{"content":[{"type":"text","text":"${inner.replace("\"", "\\\"")}"}]}}}}"""
	}

	private val LINEAR = """{"id":"PROJ-7","title":"Test","url":"https://linear.app/x/issue/PROJ-7","status":"Todo"}"""

	@Nested
	inner class FunctionCallPairs {
		@Test
		fun `pairs function_call with function_call_output`() {
			val lines = listOf(
				fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
				fnOutput("c1", LINEAR),
			)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe LinearAdapter
			result.results[0].toolName shouldBe "mcp__linear__get_issue"
		}

		@Test
		fun `handles Wall time prefix`() {
			val lines = listOf(
				fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
				fnOutput("c1", LINEAR, prefix = "Wall time: 1.2s"),
			)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
		}
	}

	@Nested
	inner class ToolCallEndFallback {
		@Test
		fun `falls back to mcp_tool_call_end when no output`() {
			val lines = listOf(
				toolCallEnd("linear_fetch", null, LINEAR),
			)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe LinearAdapter
		}

		@Test
		fun `does not double-emit when both output and event exist`() {
			val lines = listOf(
				fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
				fnOutput("c1", LINEAR),
				toolCallEnd("linear_fetch", "c1", LINEAR),
			)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
		}
	}

	@Nested
	inner class CursorHold {
		@Test
		fun `holds cursor before in-flight request`() {
			val lines = listOf(
				fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
				// No output yet — c1 is in-flight
			)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 0
			// Cursor should be held at line 0 (before the in-flight call)
			result.lastLineNumberScanned shouldBe 0
		}
	}

	@Nested
	inner class ShellCommands {
		@Test
		fun `pairs shell_command with output`() {
			val shellCall = """{"timestamp":"2024-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"s1","name":"shell_command","arguments":"{\"command\":\"gh issue view 42 --repo o/r --json title,body\"}"}}"""
			val ghPayload = """{"number":42,"title":"Fix","html_url":"https://github.com/o/r/issues/42","state":"open","repository":{"full_name":"o/r"}}"""
			val shellOutput = """{"timestamp":"2024-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"s1","output":"Exit code: 0\nOutput:\n[{\"type\":\"text\",\"text\":\"${ghPayload.replace("\"", "\\\"")}\"}]"}}"""
			val lines = listOf(shellCall, shellOutput)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe GitHubAdapter
		}

		@Test
		fun `skips non-zero exit code`() {
			val shellCall = """{"timestamp":"2024-01-01T00:00:00Z","payload":{"type":"function_call","call_id":"s1","name":"shell_command","arguments":"{\"command\":\"gh issue view 42 --repo o/r --json title\"}"}}"""
			val shellOutput = """{"timestamp":"2024-01-01T00:00:01Z","payload":{"type":"function_call_output","call_id":"s1","output":"Exit code: 1\nOutput:\nerror"}}"""
			val lines = listOf(shellCall, shellOutput)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 0
		}
	}

	@Test
	fun `respects fromLineNumber`() {
		val lines = listOf(
			fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
			fnOutput("c1", LINEAR),
			fnCall("mcp__codex_apps__linear", "_fetch", "c2"),
			fnOutput("c2", LINEAR),
		)
		val result = CodexEnvelopeParser.parse(lines, ExtractOptions(fromLineNumber = 2), adapters)
		result.results.size shouldBe 1
	}

	@Test
	fun `tolerates malformed lines`() {
		val lines = listOf(
			"not json",
			"",
			fnCall("mcp__codex_apps__linear", "_fetch", "c1"),
			fnOutput("c1", LINEAR),
		)
		val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
		result.results.size shouldBe 1
	}
}
