package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class SkillInstallerTest {

    private fun expectedVersion(): String =
        SkillInstaller::class.java
            .getResourceAsStream("/jollimemory-plugin-version.txt")
            ?.bufferedReader(Charsets.UTF_8)?.use { it.readText().trim() }
            ?.takeUnless { it.isEmpty() || it.contains("\${") } ?: "dev"

    // ── updateSkillIfNeeded ─────────────────────────────────────────────

    @Nested
    inner class UpdateSkillIfNeeded {

        @Test
        fun `creates all three SKILL_md files in the agents target and never in claude`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            for (name in SkillInstaller.SKILL_NAMES) {
                val skillFile = File(tempDir, ".agents/skills/$name/SKILL.md")
                skillFile.exists() shouldBe true
                skillFile.readText() shouldContain "name: $name"
            }
            // Claude Code target is owned by the plugin now — never written here.
            File(tempDir, ".claude/skills").exists() shouldBe false
        }

        @Test
        fun `recall template carries spec-compliant frontmatter`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val content = File(tempDir, ".agents/skills/jolli-recall/SKILL.md").readText()
            content shouldContain "name: jolli-recall"
            content shouldContain "description:"
            content shouldContain "metadata:"
            content shouldContain "vendor: \"jolli.ai\""
            content shouldContain "version: \"${expectedVersion()}\""
            content shouldContain "revision: 1"
            content shouldContain "Every commit deserves a Memory"
        }

        @Test
        fun `writes the agents target regardless of claudeEnabled`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded(claudeEnabled = false)

            File(tempDir, ".agents/skills/jolli-recall/SKILL.md").exists() shouldBe true
            // claudeEnabled no longer gates a shipped target — nothing lands in .claude/skills.
            File(tempDir, ".claude/skills").exists() shouldBe false
        }

        @Test
        fun `skips write when version matches`(@TempDir tempDir: File) {
            val installer = SkillInstaller(tempDir.absolutePath)

            installer.updateSkillIfNeeded()
            val skillFile = File(tempDir, ".agents/skills/jolli-recall/SKILL.md")
            val firstContent = skillFile.readText()
            val lastModified = skillFile.lastModified()

            Thread.sleep(50)

            // Second write — should be a no-op (version unchanged).
            installer.updateSkillIfNeeded()
            skillFile.readText() shouldBe firstContent
            skillFile.lastModified() shouldBe lastModified
        }

        @Test
        fun `upgrades a legacy revisionless file (prehistoric revision)`(@TempDir tempDir: File) {
            val skillDir = File(tempDir, ".agents/skills/jolli-recall")
            skillDir.mkdirs()
            val skillFile = File(skillDir, "SKILL.md")
            // Legacy format: no metadata.revision → treated as PREHISTORIC_REVISION → upgraded.
            skillFile.writeText(
                """---
name: jolli-recall
jolli-skill-version: 0.0.1-old
---
Old content
""",
            )

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val content = skillFile.readText()
            content shouldContain "Every commit deserves a Memory"
            content shouldContain "revision: 1"
        }

        @Test
        fun `does not downgrade a SKILL_md written by a newer revision`(@TempDir tempDir: File) {
            val skillDir = File(tempDir, ".agents/skills/jolli-recall")
            skillDir.mkdirs()
            val skillFile = File(skillDir, "SKILL.md")
            val newerContent = """---
name: jolli-recall
metadata:
  version: "9.9.9"
  revision: 999
  vendor: "jolli.ai"
---
Content from a newer tool.
"""
            skillFile.writeText(newerContent)

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            // A newer revision on disk must be left untouched (no downgrade).
            skillFile.readText() shouldBe newerContent
        }

        @Test
        fun `never overwrites a user-authored SKILL_md that lacks a Jolli ownership marker`(@TempDir tempDir: File) {
            val skillDir = File(tempDir, ".agents/skills/jolli-recall")
            skillDir.mkdirs()
            val skillFile = File(skillDir, "SKILL.md")
            // A completely user-authored file: no `vendor: "jolli.ai"`, no
            // `jolli-skill-version:`, no revision — must NEVER be clobbered.
            val userContent = """---
name: jolli-recall
description: My custom recall workflow
---
# My Custom Recall

Do it my way.
"""
            skillFile.writeText(userContent)

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            // User file untouched — the ownership guard prevents overwrite.
            skillFile.readText() shouldBe userContent
        }

        @Test
        fun `deletes legacy skill directories`(@TempDir tempDir: File) {
            val legacy1 = File(tempDir, ".claude/skills/jollimemory-recall")
            val legacy2 = File(tempDir, ".claude/skills/jolli-memory-recall")
            legacy1.mkdirs()
            File(legacy1, "SKILL.md").writeText("legacy 1")
            legacy2.mkdirs()
            File(legacy2, "SKILL.md").writeText("legacy 2")

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            // Ancient .claude/skills legacy dirs are still cleaned up on write.
            legacy1.exists() shouldBe false
            legacy2.exists() shouldBe false
            // The shipped skill lands in the .agents target (not .claude).
            File(tempDir, ".agents/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `handles missing skills directory gracefully`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()
            File(tempDir, ".agents/skills/jolli-search/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `sweeps a Jolli-owned retired jolli-pr out of the agents target`(@TempDir tempDir: File) {
            val dir = File(tempDir, ".agents/skills/jolli-pr")
            dir.mkdirs()
            File(dir, "SKILL.md").writeText("---\nname: jolli-pr\nmetadata:\n  vendor: \"jolli.ai\"\n---\nretired\n")

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            // Retired skill removed; a current skill is still written.
            dir.exists() shouldBe false
            File(tempDir, ".agents/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `keeps a user-owned jolli-pr with no ownership marker`(@TempDir tempDir: File) {
            val dir = File(tempDir, ".agents/skills/jolli-pr")
            dir.mkdirs()
            val userContent = "---\nname: jolli-pr\n---\n\n# my own PR helper\n"
            File(dir, "SKILL.md").writeText(userContent)

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            File(dir, "SKILL.md").readText() shouldBe userContent
        }
    }

    // ── Constants ────────────────────────────────────────────────────────

    @Test
    fun `SKILL_NAMES lists the two shipped skills`() {
        SkillInstaller.SKILL_NAMES shouldBe listOf("jolli-recall", "jolli-search")
    }

    @Test
    fun `REMOVED_SKILL_NAMES lists the retired jolli-pr skill`() {
        SkillInstaller.REMOVED_SKILL_NAMES shouldBe listOf("jolli-pr")
    }

    @Test
    fun `LEGACY_SKILL_DIRS contains expected names`() {
        SkillInstaller.LEGACY_SKILL_DIRS shouldBe listOf("jollimemory-recall", "jolli-memory-recall")
    }
}
