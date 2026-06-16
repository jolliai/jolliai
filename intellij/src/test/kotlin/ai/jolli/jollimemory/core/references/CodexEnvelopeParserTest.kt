package ai.jolli.jollimemory.core.references

import com.google.gson.Gson
import com.google.gson.JsonArray
import com.google.gson.JsonObject
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CodexEnvelopeParserTest {

	private val gson = Gson()
	private val adapters = listOf(LinearAdapter, JiraAdapter, GitHubAdapter, NotionAdapter)

	private fun fnCall(namespace: String, name: String, callId: String, timestamp: String = "2024-01-01T00:00:00Z"): String {
		val payload = JsonObject().apply {
			addProperty("type", "function_call")
			addProperty("call_id", callId)
			addProperty("namespace", namespace)
			addProperty("name", name)
		}
		val root = JsonObject().apply {
			addProperty("timestamp", timestamp)
			add("payload", payload)
		}
		return gson.toJson(root)
	}

	private fun fnOutput(callId: String, inner: String, timestamp: String = "2024-01-01T00:00:01Z", prefix: String = ""): String {
		val textObj = JsonObject().apply {
			addProperty("type", "text")
			addProperty("text", inner)
		}
		val content = JsonArray().apply { add(textObj) }
		val outputStr = gson.toJson(content)
		val fullOutput = if (prefix.isEmpty()) outputStr else "$prefix\nOutput:\n$outputStr"
		val payload = JsonObject().apply {
			addProperty("type", "function_call_output")
			addProperty("call_id", callId)
			addProperty("output", fullOutput)
		}
		val root = JsonObject().apply {
			addProperty("timestamp", timestamp)
			add("payload", payload)
		}
		return gson.toJson(root)
	}

	private fun toolCallEnd(tool: String, callId: String?, inner: String, timestamp: String = "2024-01-01T00:00:01Z"): String {
		val textObj = JsonObject().apply {
			addProperty("type", "text")
			addProperty("text", inner)
		}
		val content = JsonArray().apply { add(textObj) }
		val ok = JsonObject().apply { add("content", content) }
		val result = JsonObject().apply { add("Ok", ok) }
		val invocation = JsonObject().apply { addProperty("tool", tool) }
		val payload = JsonObject().apply {
			addProperty("type", "mcp_tool_call_end")
			if (callId != null) addProperty("call_id", callId)
			add("invocation", invocation)
			add("result", result)
		}
		val root = JsonObject().apply {
			addProperty("timestamp", timestamp)
			add("payload", payload)
		}
		return gson.toJson(root)
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
		private fun shellFnCall(callId: String, command: String): String {
			val argsObj = JsonObject().apply { addProperty("command", command) }
			val payload = JsonObject().apply {
				addProperty("type", "function_call")
				addProperty("call_id", callId)
				addProperty("name", "shell_command")
				addProperty("arguments", gson.toJson(argsObj))
			}
			val root = JsonObject().apply {
				addProperty("timestamp", "2024-01-01T00:00:00Z")
				add("payload", payload)
			}
			return gson.toJson(root)
		}

		@Test
		fun `pairs shell_command with output`() {
			val ghPayload = """{"number":42,"title":"Fix","html_url":"https://github.com/o/r/issues/42","state":"open","repository":{"full_name":"o/r"}}"""
			val shellCall = shellFnCall("s1", "gh issue view 42 --repo o/r --json title,body")
			val shellOutput = fnOutput("s1", ghPayload, prefix = "Exit code: 0")
			val lines = listOf(shellCall, shellOutput)
			val result = CodexEnvelopeParser.parse(lines, ExtractOptions(), adapters)
			result.results.size shouldBe 1
			result.results[0].adapter shouldBe GitHubAdapter
		}

		@Test
		fun `skips non-zero exit code`() {
			val shellCall = shellFnCall("s1", "gh issue view 42 --repo o/r --json title")
			val payload = JsonObject().apply {
				addProperty("type", "function_call_output")
				addProperty("call_id", "s1")
				addProperty("output", "Exit code: 1\nOutput:\nerror")
			}
			val root = JsonObject().apply {
				addProperty("timestamp", "2024-01-01T00:00:01Z")
				add("payload", payload)
			}
			val lines = listOf(shellCall, gson.toJson(root))
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
