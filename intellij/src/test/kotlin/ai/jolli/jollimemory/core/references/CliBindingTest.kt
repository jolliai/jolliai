package ai.jolli.jollimemory.core.references

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CliBindingTest {

	@Nested
	inner class MatchCommand {
		@Test
		fun `matches gh issue view with --json`() {
			val b = CliBinding.matchCommand("gh issue view 42 --repo o/r --json title,body")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.github
			b.canonicalToolName shouldBe "mcp__github__issue_read"
		}

		@Test
		fun `matches with --json=fields form`() {
			val b = CliBinding.matchCommand("gh issue view 42 --json=title")
			b.shouldNotBeNull()
		}

		@Test
		fun `rejects gh issue view without --json`() {
			CliBinding.matchCommand("gh issue view 42").shouldBeNull()
		}

		@Test
		fun `rejects non-gh commands`() {
			CliBinding.matchCommand("ls -la").shouldBeNull()
			CliBinding.matchCommand("git status").shouldBeNull()
		}

		@Test
		fun `matches gh in a pipeline`() {
			val b = CliBinding.matchCommand("echo test && gh issue view 42 --json title")
			b.shouldNotBeNull()
		}

		@Test
		fun `matches with env var prefix`() {
			val b = CliBinding.matchCommand("GH_TOKEN=abc gh issue view 42 --json title")
			b.shouldNotBeNull()
		}

		@Test
		fun `rejects gh pr view (not issue)`() {
			CliBinding.matchCommand("gh pr view 42 --json title").shouldBeNull()
		}
	}

	@Nested
	inner class Normalize {
		@Test
		fun `lowercases state`() {
			val raw = com.google.gson.JsonParser.parseString("""{"number":42,"title":"T","html_url":"https://github.com/o/r/issues/42","state":"CLOSED"}""")
			val b = CliBinding.matchCommand("gh issue view 42 --json title,state")!!
			val result = b.normalize(raw)!!.asJsonObject
			result.stringOrNull("state") shouldBe "closed"
		}
	}
}
