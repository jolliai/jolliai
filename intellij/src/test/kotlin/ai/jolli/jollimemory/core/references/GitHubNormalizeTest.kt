package ai.jolli.jollimemory.core.references

import com.google.gson.JsonParser
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class GitHubNormalizeTest {

	private fun parse(json: String) = JsonParser.parseString(json)

	@Nested
	inner class Unwrap {
		@Test
		fun `unwraps Codex double-wrapped issue`() {
			val raw = parse("""{"issue":{"issue_number":42,"title":"Bug","url":"https://github.com/o/r/issues/42","body":"desc","state":"open","labels":["bug"],"assignees":["alice"],"repository_full_name":"o/r"}}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 42
			result.stringOrNull("title") shouldBe "Bug"
			result.stringOrNull("html_url") shouldBe "https://github.com/o/r/issues/42"
			result.stringOrNull("body") shouldBe "desc"
			result.stringOrNull("state") shouldBe "open"
			result.objectOrNull("repository")!!.stringOrNull("full_name") shouldBe "o/r"
		}

		@Test
		fun `flat form passes through with renames`() {
			val raw = parse("""{"number":7,"title":"Fix","html_url":"https://github.com/o/r/issues/7","state":"closed"}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 7
			result.stringOrNull("html_url") shouldBe "https://github.com/o/r/issues/7"
		}
	}

	@Nested
	inner class LabelFlattening {
		@Test
		fun `flattens object labels`() {
			val raw = parse("""{"number":1,"title":"T","html_url":"https://github.com/o/r/issues/1","labels":[{"name":"bug"},{"name":"p1"}]}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			val labels = result.arrayOrNull("labels")!!
			labels.size() shouldBe 2
			labels[0].asString shouldBe "bug"
		}

		@Test
		fun `flattens mixed labels, filters empty`() {
			val raw = parse("""{"number":1,"title":"T","html_url":"https://github.com/o/r/issues/1","labels":["ok",{"name":""},{"name":"good"}]}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			val labels = result.arrayOrNull("labels")!!
			labels.size() shouldBe 2
		}
	}

	@Nested
	inner class NumberDerivation {
		@Test
		fun `derives number from URL when missing`() {
			val raw = parse("""{"title":"T","url":"https://github.com/o/r/issues/99"}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 99
		}

		@Test
		fun `derives number from pull URL`() {
			val raw = parse("""{"title":"T","url":"https://github.com/o/r/pull/55"}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 55
		}

		@Test
		fun `does not override explicit number`() {
			val raw = parse("""{"number":10,"title":"T","url":"https://github.com/o/r/issues/99"}""")
			val result = GitHubNormalize.reshape(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 10
		}
	}

	@Test
	fun `null input returns null`() {
		GitHubNormalize.reshape(null) shouldBe null
	}

	@Test
	fun `non-object passes through`() {
		val arr = parse("[1,2]")
		GitHubNormalize.reshape(arr) shouldBe arr
	}
}
