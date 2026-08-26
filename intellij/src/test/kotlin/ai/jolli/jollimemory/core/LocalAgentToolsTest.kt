package ai.jolli.jollimemory.core

import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

/**
 * Pins the static [LocalAgentTools.DEFAULT_TOOLS] baseline to the CLI-owned
 * `LOCAL_AGENT_TOOLS` map (`cli/src/core/localagent/ToolMeta.ts`). This list is a
 * hand-maintained mirror used so the IntelliJ picker always offers every backend
 * (like VS Code) even when the `ide-bridge local-agent-tools` fetch fails — adding
 * or relabelling a tool in ToolMeta.ts MUST update the Kotlin list in the same PR,
 * and this test fails loudly if the two drift.
 *
 */
class LocalAgentToolsTest {
	@Test
	fun `DEFAULT_TOOLS mirrors LOCAL_AGENT_TOOLS ids in order`() {
		LocalAgentTools.DEFAULT_TOOLS.map { it.id } shouldContainExactly
			listOf("claude-code", "codex", "cursor-agent", "opencode", "kimi", "hermes")
	}

	@Test
	fun `DEFAULT_TOOLS labels match the CLI ToolMeta labels`() {
		LocalAgentTools.DEFAULT_TOOLS.map { it.label } shouldContainExactly
			listOf("Claude Code", "Codex", "Cursor", "OpenCode", "Kimi Code", "Hermes")
	}

	@Test
	fun `every default tool carries a non-blank login hint`() {
		LocalAgentTools.DEFAULT_TOOLS.forEach { it.loginHint.isNotBlank() shouldBe true }
	}

	@Test
	fun `FALLBACK is the first default tool (Claude Code)`() {
		LocalAgentTools.FALLBACK shouldBe LocalAgentTools.DEFAULT_TOOLS.first()
		LocalAgentTools.FALLBACK.id shouldBe "claude-code"
	}
}
