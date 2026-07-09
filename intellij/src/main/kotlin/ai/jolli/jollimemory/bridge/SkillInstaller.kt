package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import java.io.File

/**
 * Manages the installation, update, and cleanup of Jolli skill files.
 *
 * Kotlin counterpart of the TypeScript SkillInstaller in
 * `cli/src/install/SkillInstaller.ts`. Writes one byte-identical `SKILL.md`
 * per skill into **both** target directories:
 *
 *   - `<projectDir>/.claude/skills/<name>/SKILL.md`  — Claude Code (gated on
 *     `claudeEnabled != false`).
 *   - `<projectDir>/.agents/skills/<name>/SKILL.md`  — the cross-platform Agent
 *     Skills standard (Codex / Cursor / Windsurf / OpenCode / Gemini / Copilot);
 *     always written.
 *
 * Three skills ship today: `jolli-recall`, `jolli-search`, `jolli-pr`. Each is
 * upserted **independently** by its content revision, so a newer skill is never
 * blocked from installing just because another skill is already current.
 *
 * ## Cross-tool idempotency — `metadata.revision`
 *
 * The write guard compares `metadata.revision`, a monotonic integer that is
 * **decoupled from any tool's release version** (npm package version / plugin
 * version) and kept in lockstep across CLI, VS Code, and IntelliJ — bumped
 * whenever a skill's body changes. Using a shared, comparable revision (instead
 * of each tool's own version string) is what stops two tools that co-manage the
 * same `SKILL.md` from endlessly rewriting each other's file. Precedence:
 *
 *   - `diskRevision  > myRevision` → skip (a NEWER tool wrote it — never downgrade)
 *   - `diskRevision == myRevision` → skip (same content by the lockstep contract)
 *   - `diskRevision  < myRevision` → overwrite (this tool is newer — upgrade)
 *   - absent/unparseable on disk (legacy `jolli-skill-version:` files) → treated
 *     as [PREHISTORIC_REVISION], so it upgrades once and then converges.
 *
 * A content hash was deliberately rejected: it would make churn-freedom depend on
 * byte-identical content across tools, so a single stray byte would reignite the
 * rewrite war. Revision comparison is forgiving of minor drift (equal revision →
 * skip regardless of exact bytes) while still giving a well-defined winner.
 *
 * Templates are loaded from bundled JAR resources at `/skills/<name>.md` with a
 * `{{SKILL_VERSION}}` placeholder replaced at runtime with the plugin version.
 * The `revision` is a literal in each `.md` (no placeholder) — the file itself is
 * the single source of truth for "my revision".
 */
class SkillInstaller(private val projectDir: String) {

    private val log = JmLogger.create("SkillInstaller")

    companion object {
        /** Skill directory names installed today, in install order. */
        val SKILL_NAMES = listOf("jolli-recall", "jolli-search", "jolli-pr")

        /** Legacy skill directory names from previous versions (cleaned up under .claude/skills). */
        val LEGACY_SKILL_DIRS = listOf("jollimemory-recall", "jolli-memory-recall")

        /**
         * Target directory families for skill writes, mirroring the CLI's
         * `SKILL_TARGETS`. `.claude/skills` is gated on `claudeEnabled != false`;
         * `.agents/skills` (the cross-platform Agent Skills standard) is unconditional.
         */
        private val SKILL_TARGETS = listOf(
            SkillTarget(".claude/skills", gatedOnClaude = true),
            SkillTarget(".agents/skills", gatedOnClaude = false),
        )

        /**
         * Matches the shared content revision in SKILL.md frontmatter
         * (`metadata.revision`, a two-space-indented integer). The whole-file
         * regex is safe because the body of every shipped skill contains no
         * `revision:` line; the first match is the frontmatter's.
         */
        private val SKILL_REVISION_LINE = Regex("""(?:^|\n)[ \t]*revision:\s*(\d+)""")

        /**
         * Revision assigned to a SKILL.md that carries no parseable `revision`
         * (a legacy `jolli-skill-version:` file, or a hand-broken frontmatter).
         * Lower than any real revision, so such a file is always upgraded once.
         */
        const val PREHISTORIC_REVISION = -1L
    }

    private data class SkillTarget(val relativeDir: String, val gatedOnClaude: Boolean)

    /**
     * Writes or updates every Jolli SKILL.md into each enabled target directory,
     * and removes legacy skill directories from previous versions.
     *
     * `claudeEnabled` gates the `.claude/skills` target (defaults to true — the
     * same "enabled unless explicitly false" semantics as the CLI). Callers that
     * have the config in hand should pass `config.claudeEnabled != false`; the
     * default is resolved from the global config when omitted.
     */
    fun updateSkillIfNeeded(claudeEnabled: Boolean = resolveClaudeEnabled()) {
        val version = resolvePluginVersion()

        // Clean up legacy skill directories — these only ever lived under .claude/skills.
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

        for (target in SKILL_TARGETS) {
            if (target.gatedOnClaude && !claudeEnabled) continue
            for (name in SKILL_NAMES) {
                val template = loadTemplate(name, version) ?: continue
                upsertSkill(File(projectDir, target.relativeDir), name, template, version)
            }
        }
    }

    /**
     * Writes one skill's SKILL.md when this tool's revision is newer than what's on
     * disk. Idempotent; never downgrades a file a newer tool wrote. See the class
     * docstring for the precedence rule.
     */
    private fun upsertSkill(skillsDir: File, name: String, content: String, version: String) {
        val skillDir = File(skillsDir, name)
        val skillPath = File(skillDir, "SKILL.md")

        // "My revision" is the literal baked into the rendered template — the file is
        // the single source of truth, so there is no separate constant to keep in sync.
        val myRevision = parseRevision(content) ?: PREHISTORIC_REVISION

        if (skillPath.exists()) {
            try {
                val existing = skillPath.readText(Charsets.UTF_8)
                val diskRevision = parseRevision(existing) ?: PREHISTORIC_REVISION
                if (diskRevision >= myRevision) {
                    // Equal → same content by contract; greater → a newer tool wrote it.
                    // Either way, leave it untouched (never downgrade).
                    return
                }
            } catch (_: Exception) {
                // File unreadable — will overwrite.
            }
        }

        try {
            skillDir.mkdirs()
            skillPath.writeText(content, Charsets.UTF_8)
            log.info("Wrote SKILL.md (version %s, revision %d) to %s", version, myRevision, skillPath.absolutePath)
        } catch (e: Exception) {
            log.info("Failed to write %s SKILL.md: %s", name, e.message)
        }
    }

    /** Parses the shared `metadata.revision` integer, or null when absent/unparseable. */
    private fun parseRevision(content: String): Long? =
        SKILL_REVISION_LINE.find(content)?.groupValues?.get(1)?.toLongOrNull()

    /**
     * Loads a skill template from the bundled JAR resource `/skills/<name>.md`.
     * Returns null if the resource cannot be found (e.g. running outside the plugin JAR).
     */
    private fun loadTemplate(name: String, version: String): String? {
        val resource = "/skills/$name.md"
        val stream = javaClass.getResourceAsStream(resource)
        if (stream == null) {
            log.info("Skill template resource not found: %s", resource)
            return null
        }
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
            .replace("{{SKILL_VERSION}}", version)
    }

    /** Resolves the `.claude/skills` gate from the global config (enabled unless explicitly false). */
    private fun resolveClaudeEnabled(): Boolean = try {
        SessionTracker.loadConfig().claudeEnabled != false
    } catch (_: Exception) {
        true
    }

    /**
     * Resolves the plugin version from the classpath resource baked in by
     * `processResources` (see build.gradle.kts) — the same mechanism
     * [ai.jolli.jollimemory.services.JolliApiClient] uses. Reading a resource
     * avoids the IntelliJ `PluginManager` API entirely (it is `@ApiStatus.Internal`
     * and tripped the Marketplace Plugin Verifier), and works identically in the
     * IDE, the hooks JAR, and tests.
     *
     * Falls back to [FALLBACK_VERSION] when the resource is missing or still
     * carries the un-expanded Gradle token (tests run without `processResources`).
     */
    private fun resolvePluginVersion(): String {
        val raw = try {
            javaClass.getResourceAsStream(VERSION_RESOURCE_PATH)
                ?.bufferedReader(Charsets.UTF_8)
                ?.use { it.readText() }
        } catch (_: Throwable) {
            null
        }
        val trimmed = raw?.trim().orEmpty()
        return if (trimmed.isEmpty() || trimmed.contains("\${")) FALLBACK_VERSION else trimmed
    }
}

/** Classpath resource holding the plugin version, populated by `processResources`. */
private const val VERSION_RESOURCE_PATH = "/jollimemory-plugin-version.txt"

/** Fallback version when the version resource is unavailable. */
private const val FALLBACK_VERSION = "dev"
