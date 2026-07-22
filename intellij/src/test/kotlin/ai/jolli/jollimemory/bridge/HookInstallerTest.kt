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

        @Test
        fun `returns true for the CLI-written run-hook entry`(@TempDir tempDir: File) {
            // The CLI's full enable writes this dispatcher form — it contains neither
            // "JolliMemory" nor "StopHook", so detection must match "run-hook" itself.
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText(
                """{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"${'$'}HOME/.jolli/jollimemory/run-hook\" stop","async":true}]}]}}""",
            )
            HookInstaller(tempDir.absolutePath).isClaudeHookInstalled() shouldBe true
        }

        @Test
        fun `ignores identifiers outside the Stop hook entries`(@TempDir tempDir: File) {
            // Matching is per hooks.Stop entry, not whole-file: unrelated settings
            // content containing an identifier must not read as installed.
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText(
                """{"permissions":{"allow":["Bash(~/bin/my-run-hook.sh)"]},"hooks":{}}""",
            )
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

        @Test
        fun `detects the pre-push marker`(@TempDir tempDir: File) {
            File(tempDir, ".git/hooks").mkdirs()
            File(tempDir, ".git/hooks/pre-push").writeText(
                "#!/bin/sh\n# >>> JolliMemory pre-push hook >>>\nscript\n# <<< JolliMemory pre-push hook <<<\n")
            HookInstaller(tempDir.absolutePath).isGitHookInstalled("pre-push", "# >>> JolliMemory pre-push hook >>>") shouldBe true
        }
    }

    // ── areAllHooksInstalled / areAllGitHooksInstalled ──────────────────

    private fun writeGitHookSection(projectDir: File, name: String) {
        File(projectDir, ".git/hooks/$name").writeText(
            "#!/bin/sh\n# >>> JolliMemory $name hook >>>\nscript\n# <<< JolliMemory $name hook <<<\n")
    }

    @Test
    fun `areAllHooksInstalled returns false when no hooks`() {
        HookInstaller("/nonexistent/path").areAllHooksInstalled() shouldBe false
    }

    @Test
    fun `areAllGitHooksInstalled requires all five sections`(@TempDir tempDir: File) {
        File(tempDir, ".git/hooks").mkdirs()
        // Legacy fat-JAR set: three hooks, no post-merge/pre-push — not complete.
        listOf("post-commit", "post-rewrite", "prepare-commit-msg").forEach { writeGitHookSection(tempDir, it) }
        val installer = HookInstaller(tempDir.absolutePath)
        installer.areAllGitHooksInstalled() shouldBe false

        listOf("post-merge", "pre-push").forEach { writeGitHookSection(tempDir, it) }
        installer.areAllGitHooksInstalled() shouldBe true
    }

    @Test
    fun `areAllHooksInstalled exempts claude when claudeRequired is false`(@TempDir tempDir: File) {
        File(tempDir, ".git/hooks").mkdirs()
        listOf("post-commit", "post-rewrite", "prepare-commit-msg", "post-merge", "pre-push")
            .forEach { writeGitHookSection(tempDir, it) }
        // No .claude/settings.local.json: with claudeEnabled == false the CLI never
        // writes one, and the install must still count as complete.
        val installer = HookInstaller(tempDir.absolutePath)
        installer.areAllHooksInstalled() shouldBe false
        installer.areAllHooksInstalled(claudeRequired = false) shouldBe true
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

    // ── legacy fat-JAR entry cleanup ────────────────────────────────────
    // Git hook section removal is the CLI's job now (uninstall runs the bundled
    // `disable`); the Kotlin side only sweeps the retired fat-JAR agent entries
    // the CLI's identifier lists don't recognize.

    @Nested
    inner class LegacyCleanup {
        @Test
        fun `removes the legacy claude stop entry`(@TempDir tempDir: File) {
            File(tempDir, ".claude").mkdirs()
            File(tempDir, ".claude/settings.local.json").writeText("""{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"java -jar jollimemory-hooks.jar stop"}]}]}}""")

            HookInstaller(tempDir.absolutePath).removeLegacyAgentHookEntries() shouldBe true

            val content = File(tempDir, ".claude/settings.local.json").readText()
            content shouldNotContain "jollimemory-hooks"
        }

        @Test
        fun `removes the legacy gemini after-agent entry`(@TempDir tempDir: File) {
            File(tempDir, ".gemini").mkdirs()
            File(tempDir, ".gemini/settings.json").writeText(
                """{"hooks":{"AfterAgent":[{"hooks":[{"type":"command","command":"java -jar jollimemory-hooks.jar gemini-after-agent","name":"jollimemory-session-tracker"}]}]}}""",
            )

            HookInstaller(tempDir.absolutePath).removeLegacyAgentHookEntries() shouldBe true

            val content = File(tempDir, ".gemini/settings.json").readText()
            content shouldNotContain "jollimemory-hooks"
            content shouldNotContain "AfterAgent"
        }

        @Test
        fun `keeps CLI-written run-hook entries untouched`(@TempDir tempDir: File) {
            File(tempDir, ".claude").mkdirs()
            val cliEntry = """{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"\"${'$'}HOME/.jolli/jollimemory/run-hook\" stop","async":true}]}]}}"""
            File(tempDir, ".claude/settings.local.json").writeText(cliEntry)

            HookInstaller(tempDir.absolutePath).removeLegacyAgentHookEntries() shouldBe false

            val content = File(tempDir, ".claude/settings.local.json").readText()
            content shouldContain "run-hook"
        }

        @Test
        fun `returns false when there are no settings files`() {
            HookInstaller("/nonexistent").removeLegacyAgentHookEntries() shouldBe false
        }

        @Test
        fun `detectLegacyGitHookBodies flags hooks that still call the fat-JAR`(@TempDir tempDir: File) {
            val hooksDir = File(tempDir, ".git/hooks").apply { mkdirs() }
            File(hooksDir, "post-commit").writeText(
                "#!/bin/sh\n# >>> JolliMemory post-commit hook >>>\n\"java\" -jar \"/opt/jollimemory-hooks.jar\" post-commit\n# <<< JolliMemory post-commit hook <<<\n",
            )
            File(hooksDir, "post-rewrite").writeText(
                "#!/bin/sh\n# >>> JolliMemory post-rewrite hook >>>\nnode /abs/run-hook post-rewrite \"\$1\"\n# <<< JolliMemory post-rewrite hook <<<\n",
            )

            HookInstaller(tempDir.absolutePath).detectLegacyGitHookBodies() shouldBe listOf("post-commit")
        }

        @Test
        fun `detectLegacyGitHookBodies returns empty when no hooks dir exists`() {
            HookInstaller("/nonexistent/path").detectLegacyGitHookBodies() shouldBe emptyList()
        }

        @Test
        fun `detectLegacyGitHookBodies resolves the worktree gitdir to the main repo hooks`(@TempDir tempDir: File) {
            val mainGitDir = File(tempDir, "main/.git").apply { mkdirs() }
            val hooksDir = File(mainGitDir, "hooks").apply { mkdirs() }
            File(mainGitDir, "worktrees/wt1").mkdirs()
            File(hooksDir, "post-commit").writeText(
                "#!/bin/sh\n# >>> JolliMemory post-commit hook >>>\n\"java\" -jar \"/opt/jollimemory-hooks.jar\" post-commit\n# <<< JolliMemory post-commit hook <<<\n",
            )
            val worktree = File(tempDir, "worktree").apply { mkdirs() }
            File(worktree, ".git").writeText("gitdir: ${mainGitDir.absolutePath}/worktrees/wt1")

            HookInstaller(worktree.absolutePath).detectLegacyGitHookBodies() shouldBe listOf("post-commit")
        }
    }

    // ── uninstall ───────────────────────────────────────────────────────

    @Test
    fun `uninstall reports a message when the CLI bundle is unavailable`() {
        // No bundled Cli.js on the test classpath: the CLI disable can't run, so
        // uninstall reports the failure instead of pretending it succeeded.
        val result = HookInstaller("/nonexistent").uninstall()
        result.message.isNotEmpty() shouldBe true
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
    fun `install fails with a message when the CLI bundle is unavailable`(@TempDir tempDir: File) {
        File(tempDir, ".git").mkdirs()
        File(tempDir, ".jolli/jollimemory").mkdirs()
        // Hook installation is fully CLI-owned: with no bundled Cli.js on the test
        // classpath the full enable can't run, so install() must fail loudly (no
        // Kotlin-side partial hook writes exist anymore).
        val result = HookInstaller(tempDir.absolutePath).install()
        result.success shouldBe false
        result.message.isNotEmpty() shouldBe true
    }
}
