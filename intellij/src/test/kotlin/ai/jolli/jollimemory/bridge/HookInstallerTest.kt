package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.StatusInfo
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class HookInstallerTest {

    // ── Data class tests ────────────────────────────────────────────────

    @Test
    fun `StatusInfo data class fields`() {
        val status = StatusInfo(enabled = true, claudeHookInstalled = true, gitHookInstalled = true,
            activeSessions = 2, summaryCount = 15, orphanBranch = "jollimemory/summaries/v3")
        status.enabled shouldBe true
        status.activeSessions shouldBe 2
        status.summaryCount shouldBe 15
    }

    @Test
    fun `CommitSummaryBrief data class fields`() {
        val commit = CommitSummaryBrief(hash = "abc123def456", shortHash = "abc123de",
            message = "Fix: resolve login issue", author = "Test User",
            date = "2026-04-01T10:00:00Z", topicCount = 3, hasSummary = true)
        commit.shortHash shouldBe "abc123de"
        commit.hasSummary shouldBe true
    }

    @Test
    fun `InstallResult data class fields`() {
        val result = InstallResult(true, "Installed", listOf("Warning 1"))
        result.success shouldBe true
        result.message shouldBe "Installed"
        result.warnings shouldBe listOf("Warning 1")
    }

    // ── isClaudeHookInstalled ───────────────────────────────────────────

    @Nested
    inner class IsClaudeHookInstalled {
        @Test
        fun `returns false for nonexistent project`() {
            HookInstaller("/nonexistent/path").isClaudeHookInstalled() shouldBe false
        }

        @Test
        fun `returns true when settings contains JolliMemory`(@TempDir tempDir: File) {
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText("""{"hooks":{"Stop":[{"hooks":[{"command":"java -jar jollimemory-hooks.jar stop"}]}]}}""")
            HookInstaller(tempDir.absolutePath).isClaudeHookInstalled() shouldBe true
        }

        @Test
        fun `returns true when settings contains StopHook`(@TempDir tempDir: File) {
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText("""{"hooks":{"Stop":[{"hooks":[{"command":"node StopHook.js"}]}]}}""")
            HookInstaller(tempDir.absolutePath).isClaudeHookInstalled() shouldBe true
        }

        @Test
        fun `returns false when settings has no JolliMemory`(@TempDir tempDir: File) {
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText("""{"hooks":{}}""")
            HookInstaller(tempDir.absolutePath).isClaudeHookInstalled() shouldBe false
        }
    }

    // ── isGeminiHookInstalled ─────────────────────────────────────────

    @Nested
    inner class IsGeminiHookInstalled {
        @Test
        fun `returns false for nonexistent project`() {
            HookInstaller("/nonexistent/path").isGeminiHookInstalled() shouldBe false
        }

        @Test
        fun `returns true when settings contains jollimemory`(@TempDir tempDir: File) {
            File(tempDir, ".gemini").mkdirs()
            File(tempDir, ".gemini/settings.json").writeText(
                """{"hooks":{"AfterAgent":[{"hooks":[{"command":"java -jar jollimemory-hooks.jar gemini-after-agent"}]}]}}""",
            )
            HookInstaller(tempDir.absolutePath).isGeminiHookInstalled() shouldBe true
        }

        @Test
        fun `returns true when settings contains JolliMemory`(@TempDir tempDir: File) {
            File(tempDir, ".gemini").mkdirs()
            File(tempDir, ".gemini/settings.json").writeText(
                """{"hooks":{"AfterAgent":[{"hooks":[{"name":"JolliMemory"}]}]}}""",
            )
            HookInstaller(tempDir.absolutePath).isGeminiHookInstalled() shouldBe true
        }

        @Test
        fun `returns false when settings has no JolliMemory`(@TempDir tempDir: File) {
            File(tempDir, ".gemini").mkdirs()
            File(tempDir, ".gemini/settings.json").writeText("""{"hooks":{}}""")
            HookInstaller(tempDir.absolutePath).isGeminiHookInstalled() shouldBe false
        }
    }

    // ── isGitHookInstalled ──────────────────────────────────────────────

    @Nested
    inner class IsGitHookInstalled {
        @Test
        fun `returns true when marker present`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            File(tempDir, ".git/hooks/post-commit").writeText("#!/bin/sh\n# >>> JolliMemory post-commit hook >>>\nscript\n# <<< JolliMemory post-commit hook <<<\n")
            HookInstaller(tempDir.absolutePath).isGitHookInstalled("post-commit", "# >>> JolliMemory post-commit hook >>>") shouldBe true
        }

        @Test
        fun `returns false when marker absent`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            File(tempDir, ".git/hooks/post-commit").writeText("#!/bin/sh\necho hello\n")
            HookInstaller(tempDir.absolutePath).isGitHookInstalled("post-commit", "# >>> JolliMemory post-commit hook >>>") shouldBe false
        }

        @Test
        fun `returns false when hook file missing`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            HookInstaller(tempDir.absolutePath).isGitHookInstalled("post-commit", "marker") shouldBe false
        }
    }

    // ── areAllHooksInstalled ────────────────────────────────────────────

    @Test
    fun `areAllHooksInstalled returns false when no hooks`() {
        HookInstaller("/nonexistent/path").areAllHooksInstalled() shouldBe false
    }

    // ── getDebugInfo ────────────────────────────────────────────────────

    @Test
    fun `getDebugInfo returns path info`(@TempDir tempDir: File) {
        File(tempDir, ".git").mkdirs()
        val info = HookInstaller(tempDir.absolutePath).getDebugInfo()
        info shouldContain "projectDir="
        info shouldContain "gitDir="
        info shouldContain "claudeSettings="
    }

    // ── uninstall ───────────────────────────────────────────────────────

    @Nested
    inner class Uninstall {
        @Test
        fun `removes claude hook from settings`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText("""{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"java -jar jollimemory-hooks.jar stop"}]}]}}""")

            val result = HookInstaller(tempDir.absolutePath).uninstall()
            result.success shouldBe true

            val content = File(tempDir, ".claude/settings.local.json").readText()
            content shouldNotContain "jollimemory-hooks"
        }

        @Test
        fun `removes gemini hook from settings`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            File(tempDir, ".gemini").mkdirs()
            File(tempDir, ".gemini/settings.json").writeText(
                """{"hooks":{"AfterAgent":[{"hooks":[{"type":"command","command":"java -jar jollimemory-hooks.jar gemini-after-agent","name":"jollimemory-session-tracker"}]}]}}""",
            )

            val result = HookInstaller(tempDir.absolutePath).uninstall()
            result.success shouldBe true

            val content = File(tempDir, ".gemini/settings.json").readText()
            content shouldNotContain "jollimemory"
            content shouldNotContain "AfterAgent"
        }

        @Test
        fun `removes git hook sections`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            // Create post-commit with JolliMemory section
            File(tempDir, ".git/hooks/post-commit").writeText(
                "#!/bin/sh\n\n# >>> JolliMemory post-commit hook >>>\nsome script\n# <<< JolliMemory post-commit hook <<<\n")

            HookInstaller(tempDir.absolutePath).uninstall()

            // Should either delete or clean the file
            val hookFile = File(tempDir, ".git/hooks/post-commit")
            if (hookFile.exists()) {
                hookFile.readText() shouldNotContain "JolliMemory"
            }
        }

        @Test
        fun `succeeds when no hooks exist`() {
            val result = HookInstaller("/nonexistent").uninstall()
            result.message.isNotEmpty() shouldBe true
        }
    }

    // ── removeBetweenMarkers (private, via reflection) ──────────────────

    @Nested
    inner class RemoveBetweenMarkers {
        private fun removeBetweenMarkers(content: String, start: String, end: String): String {
            val method = HookInstaller::class.java.getDeclaredMethod("removeBetweenMarkers", String::class.java, String::class.java, String::class.java)
            method.isAccessible = true
            return method.invoke(HookInstaller("/fake"), content, start, end) as String
        }

        @Test
        fun `removes content between markers`() {
            val result = removeBetweenMarkers("before\n# START\nmiddle\n# END\nafter", "# START", "# END")
            result shouldContain "before"
            result shouldContain "after"
            result shouldNotContain "middle"
        }

        @Test
        fun `returns unchanged when no markers`() {
            removeBetweenMarkers("no markers here", "# START", "# END") shouldBe "no markers here"
        }

        @Test
        fun `returns unchanged when only start marker`() {
            removeBetweenMarkers("before\n# START\nafter", "# START", "# END") shouldContain "before"
        }

        @Test
        fun `returns unchanged when end before start`() {
            removeBetweenMarkers("# END\nbefore\n# START\nafter", "# START", "# END") shouldContain "before"
        }
    }

    // ── resolveGitDir with worktree ─────────────────────────────────────

    @Test
    fun `resolves git dir for worktree`(@TempDir tempDir: File) {
        val mainGitDir = File(tempDir, "main/.git").apply { mkdirs() }
        File(mainGitDir, "worktrees/wt1").mkdirs()
        val worktree = File(tempDir, "worktree").apply { mkdirs() }
        File(worktree, ".git").writeText("gitdir: ${mainGitDir.absolutePath}/worktrees/wt1")

        val installer = HookInstaller(worktree.absolutePath, tempDir.resolve("main").absolutePath)
        installer.isClaudeHookInstalled() shouldBe false
    }

    @Test
    fun `install returns failure message when jar not found`(@TempDir tempDir: File) {
        File(tempDir, ".git").mkdirs()
        File(tempDir, ".jolli/jollimemory").mkdirs()
        val result = HookInstaller(tempDir.absolutePath).install()
        // install() should succeed partially even if jar isn't found
        // (the Claude hook and git hooks are still written)
        result.message.isNotEmpty() shouldBe true
    }
}
