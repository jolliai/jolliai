package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SlackAdapterTest {

	/** Build the synthetic canonical payload that ClaudeEnvelopeParser feeds SlackAdapter. */
	private fun canonical(
		channelId: String = "C0123ABCD",
		parentTs: String = "1699999999.001200",
		title: String = "Deploy plan discussion",
		text: String = "=== THREAD PARENT MESSAGE ===\nMessage TS: 1699999999.001200\nDeploy plan discussion",
		replyCount: Int = 3,
		url: String? = "https://my-team.slack.com/archives/C0123ABCD/p1699999999001200",
	): JsonObject {
		val obj = JsonObject()
		obj.addProperty("channelId", channelId)
		obj.addProperty("parentTs", parentTs)
		obj.addProperty("title", title)
		obj.addProperty("text", text)
		obj.addProperty("replyCount", replyCount)
		if (url != null) obj.addProperty("url", url)
		return obj
	}

	@Nested
	inner class Registry {
		@Test
		fun `registered in ALL_ADAPTERS`() {
			ALL_ADAPTERS.map { it.id } shouldContain SourceId.slack
			ALL_ADAPTERS.find { it.id == SourceId.slack } shouldBe SlackAdapter
		}

		@Test
		fun `Claude binding matches slack_read_thread`() {
			val resolved = ClaudeBinding.resolve("mcp__claude_ai_Slack__slack_read_thread", null)
			resolved.shouldNotBeNull()
			resolved.sourceId shouldBe SourceId.slack
		}

		@Test
		fun `Claude binding rejects other slack tools`() {
			ClaudeBinding.resolve("mcp__claude_ai_Slack__slack_send_message", null).shouldBeNull()
		}
	}

	@Nested
	inner class Metadata {
		@Test
		fun `adapter identity`() {
			SlackAdapter.id shouldBe SourceId.slack
			SlackAdapter.maxCharsPerReference shouldBe 8000
			SlackAdapter.wrapperKeys shouldBe emptyList()
		}
	}

	@Nested
	inner class ExtractRef {
		@Test
		fun `extracts a valid thread with url`() {
			val ref = SlackAdapter.extractRef(canonical(), "mcp__claude_ai_Slack__slack_read_thread", "2024-01-01T00:00:00Z")
			ref.shouldNotBeNull()
			ref.source shouldBe SourceId.slack
			ref.nativeId shouldBe "C0123ABCD-1699999999.001200"
			ref.mapKey shouldBe "slack:C0123ABCD-1699999999.001200"
			ref.title shouldBe "Deploy plan discussion"
			ref.url shouldBe "https://my-team.slack.com/archives/C0123ABCD/p1699999999001200"
			ref.fields.shouldNotBeNull()
			ref.fields!!.find { it.key == "entity-type" }!!.value shouldBe "thread"
			ref.fields.find { it.key == "replies" }!!.value shouldBe "3"
			ref.fields.find { it.key == "channel" }!!.value shouldBe "C0123ABCD"
		}

		@Test
		fun `extracts a linkless thread when url absent`() {
			val ref = SlackAdapter.extractRef(canonical(url = null), "t", "ts")
			ref.shouldNotBeNull()
			ref.url.shouldBeNull()
			ref.nativeId shouldBe "C0123ABCD-1699999999.001200"
		}

		@Test
		fun `nativeId format is channel-parentTs`() {
			val ref = SlackAdapter.extractRef(canonical(channelId = "CABC123", parentTs = "1700000001.000100"), "t", "ts")!!
			ref.nativeId shouldBe "CABC123-1700000001.000100"
		}

		@Test
		fun `rejects when channelId missing`() {
			val obj = canonical()
			obj.remove("channelId")
			SlackAdapter.extractRef(obj, "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects when parentTs malformed`() {
			SlackAdapter.extractRef(canonical(parentTs = "not-a-ts"), "t", "ts").shouldBeNull()
		}

		@Test
		fun `rejects empty title`() {
			SlackAdapter.extractRef(canonical(title = ""), "t", "ts").shouldBeNull()
		}

		@Test
		fun `voids reference when url present but not https`() {
			SlackAdapter.extractRef(canonical(url = "http://my-team.slack.com/x"), "t", "ts").shouldBeNull()
		}
	}

	@Nested
	inner class RenderPromptBlock {
		@Test
		fun `renders slack-threads XML`() {
			val ref = SlackAdapter.extractRef(canonical(), "t", "ts")!!
			val xml = SlackAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldContain "<slack-threads>"
			xml shouldContain "<thread id=\"C0123ABCD-1699999999.001200\""
			xml shouldContain "entity-type=\"thread\""
			xml shouldContain "<messages>"
			xml shouldContain "<url>"
		}

		@Test
		fun `omits url element for linkless thread`() {
			val ref = SlackAdapter.extractRef(canonical(url = null), "t", "ts")!!
			val xml = SlackAdapter.renderPromptBlock(listOf(ref), RenderOptions())
			xml shouldNotContain "<url>"
		}

		@Test
		fun `empty refs render empty string`() {
			SlackAdapter.renderPromptBlock(emptyList(), RenderOptions()) shouldBe ""
		}
	}
}
