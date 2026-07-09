package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonPrimitive
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class SlackNormalizeTest {

	private fun result(messages: String): JsonObject =
		JsonObject().apply { addProperty("messages", messages) }

	@Test
	fun `happy path extracts parentTs title and reply count`() {
		val blob = """
			=== THREAD PARENT MESSAGE ===
			Message TS: 1699999999.001200
			Ship the release today?

			=== THREAD REPLIES (2 total) ===
			--- Reply 1 of 2 ---
			Yes, after CI.
			--- Reply 2 of 2 ---
			Agreed.
		""".trimIndent()
		val c = SlackNormalize.normalizeSlackThread(result(blob), "C0123ABCD", "https://x.slack.com/y")
		c.shouldNotBeNull()
		c.channelId shouldBe "C0123ABCD"
		c.parentTs shouldBe "1699999999.001200"
		c.title shouldBe "Ship the release today?"
		c.replyCount shouldBe 2
		c.url shouldBe "https://x.slack.com/y"
		c.text.contains("=== THREAD PARENT MESSAGE ===") shouldBe true
	}

	@Test
	fun `empty parent body falls back to Slack thread ts and never borrows a reply`() {
		val blob = """
			=== THREAD PARENT MESSAGE ===
			Message TS: 1700000000.000001

			=== THREAD REPLIES (1 total) ===
			--- Reply 1 of 1 ---
			This is a reply, not the title.
		""".trimIndent()
		val c = SlackNormalize.normalizeSlackThread(result(blob), "C1", null)
		c.shouldNotBeNull()
		c.title shouldBe "Slack thread 1700000000.000001"
		c.url.shouldBeNull()
	}

	@Test
	fun `no reply marker gives zero replies`() {
		val blob = "=== THREAD PARENT MESSAGE ===\nMessage TS: 1700000000.000001\nHello"
		val c = SlackNormalize.normalizeSlackThread(result(blob), "C1", null)
		c.shouldNotBeNull()
		c.replyCount shouldBe 0
		c.title shouldBe "Hello"
	}

	@Test
	fun `returns null when messages field absent`() {
		SlackNormalize.normalizeSlackThread(JsonObject(), "C1", null).shouldBeNull()
	}

	@Test
	fun `returns null when payload is not an object`() {
		SlackNormalize.normalizeSlackThread(JsonPrimitive("nope"), "C1", null).shouldBeNull()
		SlackNormalize.normalizeSlackThread(null, "C1", null).shouldBeNull()
	}

	@Test
	fun `returns null when no parent Message TS found`() {
		val c = SlackNormalize.normalizeSlackThread(result("garbage with no ts"), "C1", null)
		c.shouldBeNull()
	}

	@Test
	fun `parses a real MCP-shaped json result`() {
		val json = JsonParser.parseString(
			"""{"messages":"=== THREAD PARENT MESSAGE ===\nMessage TS: 1699999999.001200\nTopic line"}""",
		)
		val c = SlackNormalize.normalizeSlackThread(json, "C9", null)
		c.shouldNotBeNull()
		c.title shouldBe "Topic line"
	}
}
