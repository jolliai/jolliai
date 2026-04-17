package ai.jolli.jollimemory.bridge

import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import org.junit.jupiter.api.Nested
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class SkillInstallerTest {

    // ── updateSkillIfNeeded ─────────────────────────────────────────────

    @Nested
    inner class UpdateSkillIfNeeded {

        @Test
        fun `creates SKILL_md when it does not exist`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val skillFile = File(tempDir, ".claude/skills/jolli-recall/SKILL.md")
            skillFile.exists() shouldBe true
            val content = skillFile.readText()
            content shouldContain "name: jolli-recall"
            content shouldContain "jolli-skill-version:"
            content shouldContain "Every commit deserves a Memory"
        }

        @Test
        fun `skips write when version matches`(@TempDir tempDir: File) {
            val installer = SkillInstaller(tempDir.absolutePath)

            // First write
            installer.updateSkillIfNeeded()
            val skillFile = File(tempDir, ".claude/skills/jolli-recall/SKILL.md")
            val firstContent = skillFile.readText()
            val lastModified = skillFile.lastModified()

            // Small delay to detect timestamp change
            Thread.sleep(50)

            // Second write — should be a no-op
            installer.updateSkillIfNeeded()
            skillFile.readText() shouldBe firstContent
            skillFile.lastModified() shouldBe lastModified
        }

        @Test
        fun `overwrites when version differs`(@TempDir tempDir: File) {
            val skillDir = File(tempDir, ".claude/skills/jolli-recall")
            skillDir.mkdirs()
            val skillFile = File(skillDir, "SKILL.md")
            skillFile.writeText("""---
name: jolli-recall
jolli-skill-version: 0.0.1-old
---
Old content
""")

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val content = skillFile.readText()
            content shouldContain "Every commit deserves a Memory"
            // Should have the new version (dev in test context), not the old one
            content shouldContain "jolli-skill-version: dev"
        }

        @Test
        fun `deletes legacy skill directories`(@TempDir tempDir: File) {
            // Create legacy directories
            val legacy1 = File(tempDir, ".claude/skills/jollimemory-recall")
            val legacy2 = File(tempDir, ".claude/skills/jolli-memory-recall")
            legacy1.mkdirs()
            File(legacy1, "SKILL.md").writeText("legacy 1")
            legacy2.mkdirs()
            File(legacy2, "SKILL.md").writeText("legacy 2")

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            legacy1.exists() shouldBe false
            legacy2.exists() shouldBe false
            // And the new skill should exist
            File(tempDir, ".claude/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `handles missing claude skills directory gracefully`(@TempDir tempDir: File) {
            // No .claude/ directory exists — should create it
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()
            File(tempDir, ".claude/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `template contains required frontmatter fields`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val content = File(tempDir, ".claude/skills/jolli-recall/SKILL.md").readText()
            content shouldContain "name: jolli-recall"
            content shouldContain "description:"
            content shouldContain "argument-hint:"
            content shouldContain "user-invocable: true"
            content shouldContain "jolli-skill-version:"
        }
    }

    // ── Constants ────────────────────────────────────────────────────────

    @Test
    fun `SKILL_NAME is jolli-recall`() {
        SkillInstaller.SKILL_NAME shouldBe "jolli-recall"
    }

    @Test
    fun `LEGACY_SKILL_DIRS contains expected names`() {
        SkillInstaller.LEGACY_SKILL_DIRS shouldBe listOf("jollimemory-recall", "jolli-memory-recall")
    }
}
