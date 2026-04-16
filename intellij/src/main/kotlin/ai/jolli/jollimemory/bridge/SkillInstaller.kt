package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import java.io.File

/**
 * Manages the installation, update, and cleanup of Jolli skill files
 * for Claude Code (.claude/skills/ SKILL.md files).
 *
 * This is the Kotlin counterpart of the TypeScript SkillInstaller in
 * `tools/jollimemory/src/install/SkillInstaller.ts`. Both implementations
 * use the same version-guard mechanism and template content, ensuring
 * VS Code and IntelliJ can coexist without conflicts.
 *
 * The skill template is loaded from a bundled JAR resource at
 * `/skills/jolli-recall.md` with a `{{SKILL_VERSION}}` placeholder
 * replaced at runtime with the plugin version.
 */
class SkillInstaller(private val projectDir: String) {

    private val log = JmLogger.create("SkillInstaller")

    companion object {
        /** Current skill directory name. */
        const val SKILL_NAME = "jolli-recall"

        /** Legacy skill directory names from previous versions. */
        val LEGACY_SKILL_DIRS = listOf("jollimemory-recall", "jolli-memory-recall")

        /** Resource path for the bundled skill template. */
        private const val TEMPLATE_RESOURCE = "/skills/jolli-recall.md"
    }

    /**
     * Writes or updates the /jolli-recall SKILL.md file.
     * Also removes legacy skill directories from previous versions.
     *
     * Uses a version guard: only writes when the version in frontmatter differs
     * from the current plugin version, or when the file doesn't exist yet.
     */
    fun updateSkillIfNeeded() {
        val version = resolvePluginVersion()

        // Clean up legacy skill directories
        for (legacyName in LEGACY_SKILL_DIRS) {
            val legacyDir = File(projectDir, ".claude/skills/$legacyName")
            try {
                if (legacyDir.exists()) {
                    legacyDir.deleteRecursively()
                    log.info("Removed legacy skill directory: %s", legacyDir.absolutePath)
                }
            } catch (e: Exception) {
                log.info("Failed to remove legacy skill dir %s: %s", legacyName, e.message)
            }
        }

        val skillDir = File(projectDir, ".claude/skills/$SKILL_NAME")
        val skillPath = File(skillDir, "SKILL.md")

        // Check existing version
        if (skillPath.exists()) {
            try {
                val existing = skillPath.readText(Charsets.UTF_8)
                val versionMatch = Regex("""jolli-skill-version:\s*(.+)""").find(existing)
                if (versionMatch != null && versionMatch.groupValues[1].trim() == version) {
                    return // Version matches — no update needed
                }
            } catch (_: Exception) {
                // File unreadable — will overwrite
            }
        }

        // Load template from JAR resource and replace version placeholder
        val template = loadTemplate(version) ?: return

        try {
            skillDir.mkdirs()
            skillPath.writeText(template, Charsets.UTF_8)
            log.info("Wrote SKILL.md (version %s) to %s", version, skillPath.absolutePath)
        } catch (e: Exception) {
            log.info("Failed to write SKILL.md: %s", e.message)
        }

    }

    /**
     * Loads the skill template from the bundled JAR resource.
     * Returns null if the resource cannot be found (e.g., running outside the plugin JAR).
     */
    private fun loadTemplate(version: String): String? {
        val stream = javaClass.getResourceAsStream(TEMPLATE_RESOURCE)
        if (stream == null) {
            log.info("Skill template resource not found: %s", TEMPLATE_RESOURCE)
            return null
        }
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
            .replace("{{SKILL_VERSION}}", version)
    }

    /**
     * Resolves the plugin version.
     *
     * Tries IntelliJ's PluginManager API first (runtime in IDE), then falls
     * back to a hardcoded version for non-IDE contexts (tests, hooks JAR).
     */
    private fun resolvePluginVersion(): String {
        return try {
            val pluginId = com.intellij.openapi.extensions.PluginId.getId("ai.jolli.jollimemory")
            val plugin = com.intellij.ide.plugins.PluginManagerCore.getPlugin(pluginId)
            plugin?.version ?: FALLBACK_VERSION
        } catch (_: Throwable) {
            // NoClassDefFoundError when running outside IntelliJ (tests, hooks JAR)
            FALLBACK_VERSION
        }
    }
}

/** Fallback version when IntelliJ Plugin API is unavailable. */
private const val FALLBACK_VERSION = "dev"
