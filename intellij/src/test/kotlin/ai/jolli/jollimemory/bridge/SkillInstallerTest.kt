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
        fun `creates all three SKILL_md files in both target dirs`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            for (root in listOf(".claude/skills", ".agents/skills")) {
                for (name in SkillInstaller.SKILL_NAMES) {
                    val skillFile = File(tempDir, "$root/$name/SKILL.md")
                    skillFile.exists() shouldBe true
                    skillFile.readText() shouldContain "name: $name"
                }
            }
        }

        @Test
        fun `recall template carries spec-compliant frontmatter`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            val content = File(tempDir, ".claude/skills/jolli-recall/SKILL.md").readText()
            content shouldContain "name: jolli-recall"
            content shouldContain "description:"
            content shouldContain "metadata:"
            content shouldContain "vendor: \"jolli.ai\""
            content shouldContain "version: \"${expectedVersion()}\""
            content shouldContain "revision: 1"
            content shouldContain "Every commit deserves a Memory"
        }

        @Test
        fun `claudeEnabled false skips claude target but still writes agents target`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded(claudeEnabled = false)

            File(tempDir, ".claude/skills/jolli-recall/SKILL.md").exists() shouldBe false
            File(tempDir, ".agents/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `skips write when version matches`(@TempDir tempDir: File) {
            val installer = SkillInstaller(tempDir.absolutePath)

            installer.updateSkillIfNeeded()
            val skillFile = File(tempDir, ".claude/skills/jolli-recall/SKILL.md")
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
            val skillDir = File(tempDir, ".claude/skills/jolli-recall")
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
            val skillDir = File(tempDir, ".claude/skills/jolli-recall")
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
        fun `deletes legacy skill directories`(@TempDir tempDir: File) {
            val legacy1 = File(tempDir, ".claude/skills/jollimemory-recall")
            val legacy2 = File(tempDir, ".claude/skills/jolli-memory-recall")
            legacy1.mkdirs()
            File(legacy1, "SKILL.md").writeText("legacy 1")
            legacy2.mkdirs()
            File(legacy2, "SKILL.md").writeText("legacy 2")

            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()

            legacy1.exists() shouldBe false
            legacy2.exists() shouldBe false
            File(tempDir, ".claude/skills/jolli-recall/SKILL.md").exists() shouldBe true
        }

        @Test
        fun `handles missing skills directory gracefully`(@TempDir tempDir: File) {
            SkillInstaller(tempDir.absolutePath).updateSkillIfNeeded()
            File(tempDir, ".claude/skills/jolli-pr/SKILL.md").exists() shouldBe true
        }
    }

    // ── Constants ────────────────────────────────────────────────────────

    @Test
    fun `SKILL_NAMES lists the three shipped skills`() {
        SkillInstaller.SKILL_NAMES shouldBe listOf("jolli-recall", "jolli-search", "jolli-pr")
    }

    @Test
    fun `LEGACY_SKILL_DIRS contains expected names`() {
        SkillInstaller.LEGACY_SKILL_DIRS shouldBe listOf("jollimemory-recall", "jolli-memory-recall")
    }
}
