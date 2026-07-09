package ai.jolli.jollimemory.core.references

import io.kotest.matchers.maps.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class SlackPermalinkTest {

	@Nested
	inner class ParseSlackPermalink {
		@Test
		fun `parses a valid permalink and dots the ts`() {
			val p = SlackPermalink.parseSlackPermalink(
				"see https://my-team.slack.com/archives/C0123ABCD/p1699999999001200 for context",
			)
			p.shouldNotBeNull()
			p.workspace shouldBe "my-team"
			p.channel shouldBe "C0123ABCD"
			// 16 digits → 10-digit seconds + 6-digit microseconds
			p.parentTs shouldBe "1699999999.001200"
			p.url shouldBe "https://my-team.slack.com/archives/C0123ABCD/p1699999999001200"
		}

		@Test
		fun `returns null on non-slack url`() {
			SlackPermalink.parseSlackPermalink("https://example.com/archives/C1/p1699999999001200").shouldBeNull()
		}

		@Test
		fun `returns null when no permalink present`() {
			SlackPermalink.parseSlackPermalink("just some text").shouldBeNull()
		}
	}

	@Nested
	inner class ScanUserPermalinks {
		private fun userText(text: String): String =
			"""{"message":{"role":"user","content":[{"type":"text","text":"$text"}]}}"""

		@Test
		fun `harvests permalink from role-user text keyed by channel and ts`() {
			val lines = listOf(
				userText("https://my-team.slack.com/archives/C0123ABCD/p1699999999001200"),
			)
			val map = SlackPermalink.scanUserPermalinks(lines)
			map shouldContainExactly mapOf(
				"C0123ABCD:1699999999.001200" to "https://my-team.slack.com/archives/C0123ABCD/p1699999999001200",
			)
		}

		@Test
		fun `ignores assistant and tool_result lines`() {
			val assistantLine =
				"""{"message":{"role":"assistant","content":[{"type":"text","text":"https://my-team.slack.com/archives/C1/p1699999999001200"}]}}"""
			val map = SlackPermalink.scanUserPermalinks(listOf(assistantLine))
			map.isEmpty() shouldBe true
		}

		@Test
		fun `skips lines without the archives substring cheaply`() {
			val map = SlackPermalink.scanUserPermalinks(listOf(userText("no link here")))
			map.isEmpty() shouldBe true
		}

		@Test
		fun `tolerates malformed json lines`() {
			val map = SlackPermalink.scanUserPermalinks(listOf("not json but has .slack.com/archives/ text"))
			map.isEmpty() shouldBe true
		}
	}
}
