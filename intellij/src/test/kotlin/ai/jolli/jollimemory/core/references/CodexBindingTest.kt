package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class CodexBindingTest {

	@Nested
	inner class FromFunctionCall {
		@Test
		fun `resolves linear fetch`() {
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__linear", "_fetch")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.linear
			b.canonicalToolName shouldBe "mcp__linear__get_issue"
		}

		@Test
		fun `resolves notion fetch`() {
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__notion", "_fetch")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.notion
		}

		@Test
		fun `resolves github fetch_issue`() {
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__github", "_fetch_issue")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.github
		}

		@Test
		fun `resolves jira getjiraissue`() {
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.jira
		}

		@Test
		fun `rejects unknown namespace`() {
			CodexBinding.fromFunctionCall("mcp__codex_apps__slack", "_fetch").shouldBeNull()
		}

		@Test
		fun `rejects wrong function name`() {
			CodexBinding.fromFunctionCall("mcp__codex_apps__linear", "_search").shouldBeNull()
		}

		@Test
		fun `rejects non-codex namespace`() {
			CodexBinding.fromFunctionCall("mcp__other__linear", "_fetch").shouldBeNull()
		}
	}

	@Nested
	inner class FromInvocationTool {
		@Test
		fun `resolves linear_fetch`() {
			val b = CodexBinding.fromInvocationTool("linear_fetch")
			b.shouldNotBeNull()
			b.id shouldBe SourceId.linear
		}

		@Test
		fun `resolves notion_fetch`() {
			CodexBinding.fromInvocationTool("notion_fetch").shouldNotBeNull()
		}

		@Test
		fun `resolves github_fetch_issue`() {
			CodexBinding.fromInvocationTool("github_fetch_issue").shouldNotBeNull()
		}

		@Test
		fun `resolves atlassian rovo_getjiraissue`() {
			CodexBinding.fromInvocationTool("atlassian rovo_getjiraissue").shouldNotBeNull()
		}

		@Test
		fun `rejects unknown tool`() {
			CodexBinding.fromInvocationTool("slack_post").shouldBeNull()
		}
	}

	@Nested
	inner class GitHubNormalize {
		@Test
		fun `github binding reshapes single entity`() {
			val raw = JsonParser.parseString("""{"issue":{"issue_number":42,"title":"Bug","url":"https://github.com/o/r/issues/42","state":"open"}}""")
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__github", "_fetch_issue")!!
			val result = b.normalize(raw)!!.asJsonObject
			result.intOrNull("number") shouldBe 42
			result.stringOrNull("html_url") shouldBe "https://github.com/o/r/issues/42"
		}
	}

	@Nested
	inner class JiraNormalize {
		@Test
		fun `jira binding passes through adapter-shaped payload`() {
			val raw = JsonParser.parseString("""{"key":"KAN-1","fields":{"summary":"Test"},"webUrl":"https://x.atlassian.net/browse/KAN-1"}""")
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")!!
			val result = b.normalize(raw)!!.asJsonObject
			result.stringOrNull("key") shouldBe "KAN-1"
		}

		@Test
		fun `jira recovery adds missing webUrl`() {
			val event = JsonParser.parseString("""{"key":"KAN-1","fields":{"summary":"Test"}}""")
			val rawOutput = """{"webUrl":"https://x.atlassian.net/browse/KAN-1","other":"stuff"}"""
			val b = CodexBinding.fromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")!!
			val result = b.recover(event, rawOutput)
			result.shouldNotBeNull()
			result.asJsonObject.stringOrNull("webUrl") shouldBe "https://x.atlassian.net/browse/KAN-1"
		}

		@Test
		fun `jira recovery returns null when webUrl already present`() {
			val event = JsonParser.parseString("""{"key":"KAN-1","webUrl":"https://existing.com/browse/KAN-1"}""")
			CodexBinding.fromFunctionCall("mcp__codex_apps__atlassian_rovo", "_getjiraissue")!!
				.recover(event, """{"webUrl":"https://other.com/browse/KAN-1"}""") shouldBe event
		}
	}
}
