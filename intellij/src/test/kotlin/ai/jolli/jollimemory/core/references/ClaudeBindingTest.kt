package ai.jolli.jollimemory.core.references

import com.google.gson.JsonObject
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test

class ClaudeBindingTest {

	@Nested
	inner class BindingForToolName {
		@Test
		fun `matches GitHub prefix`() {
			val result = ClaudeBinding.bindingForToolName("mcp__github__get_issue")
			result.shouldNotBeNull()
			result.first shouldBe SourceId.github
		}

		@Test
		fun `matches Jira prefix`() {
			val result = ClaudeBinding.bindingForToolName("mcp__claude_ai_Atlassian__getJiraIssue")
			result.shouldNotBeNull()
			result.first shouldBe SourceId.jira
		}

		@Test
		fun `matches Linear prefix`() {
			val result = ClaudeBinding.bindingForToolName("mcp__linear__get_issue")
			result.shouldNotBeNull()
			result.first shouldBe SourceId.linear
		}

		@Test
		fun `matches Notion only for notion-fetch`() {
			val result = ClaudeBinding.bindingForToolName("mcp__claude_ai_Notion__notion-fetch")
			result.shouldNotBeNull()
			result.first shouldBe SourceId.notion
		}

		@Test
		fun `rejects Notion non-fetch tools`() {
			ClaudeBinding.bindingForToolName("mcp__claude_ai_Notion__notion-search").shouldBeNull()
			ClaudeBinding.bindingForToolName("mcp__claude_ai_Notion__notion-update").shouldBeNull()
		}

		@Test
		fun `rejects unknown prefixes`() {
			ClaudeBinding.bindingForToolName("mcp__slack__send_message").shouldBeNull()
		}
	}

	@Nested
	inner class Resolve {
		@Test
		fun `resolves MCP tool`() {
			val resolved = ClaudeBinding.resolve("mcp__linear__get_issue", null)
			resolved.shouldNotBeNull()
			resolved.sourceId shouldBe SourceId.linear
			resolved.kind shouldBe ClaudeBinding.Kind.mcp
			resolved.toolName shouldBe "mcp__linear__get_issue"
		}

		@Test
		fun `resolves Bash CLI tool`() {
			val input = JsonObject()
			input.addProperty("command", "gh issue view 42 --repo o/r --json title,body")
			val resolved = ClaudeBinding.resolve("Bash", input)
			resolved.shouldNotBeNull()
			resolved.sourceId shouldBe SourceId.github
			resolved.kind shouldBe ClaudeBinding.Kind.cli
			resolved.toolName shouldBe "mcp__github__issue_read"
		}

		@Test
		fun `returns null for non-matching Bash command`() {
			val input = JsonObject()
			input.addProperty("command", "ls -la")
			ClaudeBinding.resolve("Bash", input).shouldBeNull()
		}

		@Test
		fun `returns null for unknown tool`() {
			ClaudeBinding.resolve("unknown_tool", null).shouldBeNull()
		}
	}

	@Test
	fun `TOOL_PREFIXES has all rule prefixes`() {
		ClaudeBinding.TOOL_PREFIXES shouldBe listOf(
			"mcp__github__", "mcp__claude_ai_Atlassian__", "mcp__linear__", "mcp__claude_ai_Notion__"
		)
	}
}
