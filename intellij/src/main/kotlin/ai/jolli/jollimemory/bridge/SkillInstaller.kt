package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import java.io.File

/**
 * Manages the installation, update, and cleanup of Jolli skill files.
 *
 * Kotlin counterpart of the TypeScript SkillInstaller in
 * `cli/src/install/SkillInstaller.ts`. Writes one `SKILL.md` per skill into the
 * cross-platform target only:
 *
 *   - `<projectDir>/.agents/skills/<name>/SKILL.md`  — the cross-platform Agent
 *     Skills standard (Codex / Cursor / Windsurf / OpenCode / Gemini / Copilot);
 *     always written.
 *
 * **Claude Code (`.claude/skills/`) is deliberately NOT a write target.** The
 * Claude Code plugin owns Claude Code skills as namespaced `/jolli:*`, so writing
 * unnamespaced `.claude/skills/jolli-*` here would only duplicate them in the `/`
 * menu (mirrors the CLI — see the module header of `SkillInstaller.ts`). Legacy
 * `.claude/skills/` directory names are still cleaned up on write.
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
         * `SKILL_TARGETS`. Only the cross-platform `.agents/skills` target ships —
         * Claude Code (`.claude/skills`) is owned by the plugin now, so it is
         * intentionally absent. `gatedOnClaude` is retained as the re-gating
         * extension point (the one shipped target is unconditional).
         */
        private val SKILL_TARGETS = listOf(
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
     * Writes or updates every Jolli SKILL.md into each enabled target directory
     * (today only the cross-platform `.agents/skills`), and removes legacy skill
     * directories from previous versions.
     *
     * `claudeEnabled` is retained for the `gatedOnClaude` extension point and the
     * same "enabled unless explicitly false" semantics as the CLI; it no longer
     * gates a shipped target (Claude Code is owned by the plugin). The default is
     * resolved from the global config when omitted.
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
     *
     * A file that carries NO Jolli ownership marker (`vendor: "jolli.ai"` or the
     * legacy `jolli-skill-version:` frontmatter) is treated as user-authored and
     * is NEVER overwritten — mirrors the TS-side `isJolliOwnedSkill` guard in
     * `cli/src/install/SkillInstaller.ts`.
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
                // Never overwrite a user-authored skill — it lacks the ownership marker.
                if (!isJolliOwnedSkill(existing)) {
                    log.info("Skipping %s SKILL.md — no Jolli ownership marker (user-owned)", name)
                    return
                }
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

    /**
     * True when the file content carries a Jolli ownership marker — either the
     * modern `vendor: "jolli.ai"` metadata or the legacy `jolli-skill-version:`
     * frontmatter. A file with neither was hand-authored by the user and must
     * never be overwritten. Mirrors `isJolliOwnedSkill` in the TS SkillInstaller.
     */
    private fun isJolliOwnedSkill(content: String): Boolean =
        content.contains("vendor: \"jolli.ai\"") || content.contains("jolli-skill-version:")

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
