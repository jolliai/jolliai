package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * End-to-end: the Claude envelope parser threading the tool_use input +
 * permalink correlation into a synthetic Slack canonical payload, and the
 * SlackAdapter turning that into a Reference.
 */
class SlackEnvelopeParserTest {

	private val adapters = ALL_ADAPTERS

	private val channel = "C0123ABCD"
	private val ts = "1699999999.001200"
	private val permalink = "https://my-team.slack.com/archives/C0123ABCD/p1699999999001200"

	private fun permalinkUserLine(): String =
		"""{"message":{"role":"user","content":[{"type":"text","text":"look at $permalink please"}]}}"""

	private fun toolUseLine(): String =
		"""{"timestamp":"2024-01-01T00:00:00Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"mcp__claude_ai_Slack__slack_read_thread","input":{"channel_id":"$channel","message_ts":"$ts"}}]}}"""

	private fun toolResultLine(): String {
		val blob = "=== THREAD PARENT MESSAGE ===\nMessage TS: $ts\nDeploy plan discussion\n=== THREAD REPLIES (1 total) ===\n--- Reply 1 of 1 ---\nSounds good."
		val payloadJson = """{"messages":"$blob"}""".replace("\"", "\\\"")
		return """{"timestamp":"2024-01-01T00:00:01Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":[{"type":"text","text":"$payloadJson"}]}]}}"""
	}

	private fun slackRef(result: NormalizedToolResult): Reference? =
		SlackAdapter.extractRef(result.payload as JsonObject, result.toolName, result.referencedAt)

	@Test
	fun `correlates pasted permalink to the thread url`() {
		val lines = listOf(permalinkUserLine(), toolUseLine(), toolResultLine())
		val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
		result.results.size shouldBe 1
		result.results[0].adapter shouldBe SlackAdapter
		val ref = slackRef(result.results[0])
		ref.shouldNotBeNull()
		ref.nativeId shouldBe "$channel-$ts"
		ref.title shouldBe "Deploy plan discussion"
		ref.url shouldBe permalink
	}

	@Test
	fun `reconstructs url from configured workspace when no permalink pasted`() {
		val lines = listOf(toolUseLine(), toolResultLine())
		val opts = ExtractOptions(slackWorkspaceUrl = "https://my-team.slack.com")
		val result = ClaudeEnvelopeParser.parse(lines, opts, adapters)
		result.results.size shouldBe 1
		val ref = slackRef(result.results[0])
		ref.shouldNotBeNull()
		// message_ts dot stripped, prefixed with p
		ref.url shouldBe "https://my-team.slack.com/archives/$channel/p1699999999001200"
	}

	@Test
	fun `captures a linkless thread when no permalink and no workspace url`() {
		val lines = listOf(toolUseLine(), toolResultLine())
		val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(), adapters)
		result.results.size shouldBe 1
		val ref = slackRef(result.results[0])
		ref.shouldNotBeNull()
		ref.url.shouldBeNull()
	}

	@Test
	fun `pairs a tool_use before the cursor with a result after it (incremental scan boundary)`() {
		// Regression: a discovery tick landed between the tool_use (index 1) and its
		// tool_result (index 2), so the cursor sits at index 2. The tool_use before
		// the cursor must still be scanned or the result can never pair and the
		// reference is silently dropped. Before the fix this returned 0 results.
		val lines = listOf(permalinkUserLine(), toolUseLine(), toolResultLine())
		val result = ClaudeEnvelopeParser.parse(lines, ExtractOptions(fromLineNumber = 2), adapters)
		result.results.size shouldBe 1
		val ref = slackRef(result.results[0])
		ref.shouldNotBeNull()
		ref.nativeId shouldBe "$channel-$ts"
		ref.url shouldBe permalink
	}
}
