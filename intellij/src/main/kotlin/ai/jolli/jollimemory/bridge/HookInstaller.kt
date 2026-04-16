package ai.jolli.jollimemory.bridge

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import ai.jolli.jollimemory.core.JmLogger
import java.io.File

/**
 * Installs and removes JolliMemory hooks — pure Kotlin, no Node.js.
 *
 * Hooks installed:
 *   1. Claude Code Stop hook in .claude/settings.local.json
 *   2. Git post-commit hook in .git/hooks/post-commit
 *   3. Git post-rewrite hook in .git/hooks/post-rewrite
 *   4. Git prepare-commit-msg hook in .git/hooks/prepare-commit-msg
 *
 * The hook scripts themselves call Node.js (for AI summarization), but the
 * INSTALLATION is pure file I/O — no Node.js needed on the plugin side.
 */
class HookInstaller(private val projectDir: String, private val mainRepoRoot: String = projectDir) {

    private val log = JmLogger.create("HookInstaller")
    private val gson = GsonBuilder().setPrettyPrinting().create()

    /**
     * Resolves the actual .git directory path.
     * In a worktree, `.git` is a file containing "gitdir: /path/to/main/.git/worktrees/<name>".
     * Hooks and config live in the main repo's .git, not the worktree's.
     */
    private fun resolveGitDir(): String {
        val gitEntry = File(projectDir, ".git")
        if (gitEntry.isDirectory) return gitEntry.absolutePath
        if (gitEntry.isFile) {
            try {
                val line = gitEntry.readText(Charsets.UTF_8).trim()
                if (line.startsWith("gitdir:")) {
                    val gitdirPath = line.removePrefix("gitdir:").trim()
                    // This points to .git/worktrees/<name>; hooks are in the main .git/hooks
                    val mainGitDir = File(gitdirPath).parentFile?.parentFile
                    if (mainGitDir != null && mainGitDir.isDirectory) {
                        return mainGitDir.absolutePath
                    }
                    // Fallback: use the gitdir path directly
                    return gitdirPath
                }
            } catch (_: Exception) { }
        }
        return File(projectDir, ".git").absolutePath
    }

    /**
     * Ensures `.jolli/` is listed in the project's `.gitignore`.
     * Prevents accidental commits of API keys stored in `.jolli/jollimemory/config.json`.
     */
    private fun ensureGitignoreEntry(projectRoot: String) {
        val gitignore = File(projectRoot, ".gitignore")
        val entry = ".jolli/"
        if (gitignore.exists()) {
            val content = gitignore.readText(Charsets.UTF_8)
            // Check if already covered (exact line match)
            if (content.lines().any { it.trim() == entry || it.trim() == ".jolli" }) return
            // Append entry
            val separator = if (content.endsWith("\n")) "" else "\n"
            gitignore.appendText("${separator}${entry}\n", Charsets.UTF_8)
        } else {
            gitignore.writeText("${entry}\n", Charsets.UTF_8)
        }
        log.info("Added %s to .gitignore", entry)
    }

    companion object {
        private const val POST_COMMIT_START = "# >>> JolliMemory post-commit hook >>>"
        private const val POST_COMMIT_END = "# <<< JolliMemory post-commit hook <<<"
        private const val POST_REWRITE_START = "# >>> JolliMemory post-rewrite hook >>>"
        private const val POST_REWRITE_END = "# <<< JolliMemory post-rewrite hook <<<"
        private const val PREPARE_MSG_START = "# >>> JolliMemory prepare-commit-msg hook >>>"
        private const val PREPARE_MSG_END = "# <<< JolliMemory prepare-commit-msg hook <<<"
    }

    /** Check if Claude Code Stop hook is installed (checks main repo's .claude/). */
    fun isClaudeHookInstalled(): Boolean {
        val settingsPath = File(mainRepoRoot, ".claude/settings.local.json")
        if (!settingsPath.exists()) return false
        return try {
            val content = settingsPath.readText(Charsets.UTF_8)
            // Match any JolliMemory hook variant: Node.js (StopHook.js) or Kotlin (jollimemory-hooks.jar stop)
            content.contains("JolliMemory") || content.contains("StopHook") || content.contains("jollimemory-hooks")
        } catch (_: Exception) {
            false
        }
    }

    /** Returns debug info about paths being checked. */
    fun getDebugInfo(): String {
        val gitDir = resolveGitDir()
        val claudePath = File(mainRepoRoot, ".claude/settings.local.json")
        val postCommit = File(gitDir, "hooks/post-commit")
        return "projectDir=$projectDir, mainRepoRoot=$mainRepoRoot, " +
            "gitDir=$gitDir, " +
            "claudeSettings=${claudePath.absolutePath} (exists=${claudePath.exists()}), " +
            "postCommit=${postCommit.absolutePath} (exists=${postCommit.exists()})"
    }

    /** Check if a git hook section is installed. */
    fun isGitHookInstalled(hookName: String, marker: String): Boolean {
        val hookFile = File(resolveGitDir(), "hooks/$hookName")
        if (!hookFile.exists()) return false
        return try {
            hookFile.readText(Charsets.UTF_8).contains(marker)
        } catch (_: Exception) {
            false
        }
    }

    /** Check if Gemini AfterAgent hook is installed in .gemini/settings.json. */
    fun isGeminiHookInstalled(): Boolean {
        val settingsPath = File(projectDir, ".gemini/settings.json")
        if (!settingsPath.exists()) return false
        return try {
            val content = settingsPath.readText(Charsets.UTF_8)
            content.contains("JolliMemory") || content.contains("jollimemory")
        } catch (_: Exception) {
            false
        }
    }

    /** Check if Claude Code directory (~/.claude/) exists. */
    fun isClaudeDetected(): Boolean {
        val home = System.getProperty("user.home")
        return File("$home/.claude").isDirectory
    }

    /** Check all required hooks. */
    fun areAllHooksInstalled(): Boolean {
        return isClaudeHookInstalled() &&
            isGitHookInstalled("post-commit", POST_COMMIT_START) &&
            isGitHookInstalled("post-rewrite", POST_REWRITE_START) &&
            isGitHookInstalled("prepare-commit-msg", PREPARE_MSG_START)
    }

    /**
     * Install all hooks.
     * Returns a result message.
     */
    fun install(): InstallResult {
        val warnings = mutableListOf<String>()
        val installLog = StringBuilder()
        try {
            // Ensure .jolli/jollimemory directory
            File(projectDir, ".jolli/jollimemory").mkdirs()
            installLog.appendLine("Created .jolli/jollimemory dir")

            // Ensure .jolli/ is in the project's .gitignore to prevent API key leakage
            ensureGitignoreEntry(projectDir)
            installLog.appendLine("Checked .gitignore for .jolli/ entry")

            // Find/extract hooks JAR
            val jar = findHooksJar()
            // Debug: log where the classloader finds the plugin
            val classLocation = try {
                HookInstaller::class.java.protectionDomain?.codeSource?.location?.toURI()?.toString() ?: "null"
            } catch (e: Exception) { "error: ${e.message}" }
            installLog.appendLine("classLocation=$classLocation")
            installLog.appendLine("hooks JAR: $jar")

            // Install Claude Code hook
            installClaudeHook()
            installLog.appendLine("Claude hook installed")

            // Install Gemini CLI hook (if Gemini is detected)
            installGeminiHook()
            installLog.appendLine("Gemini hook installed")

            // Install git hooks
            installGitHook("post-commit", POST_COMMIT_START, POST_COMMIT_END, postCommitScript())
            installGitHook("post-rewrite", POST_REWRITE_START, POST_REWRITE_END, postRewriteScript())
            installGitHook("prepare-commit-msg", PREPARE_MSG_START, PREPARE_MSG_END, prepareMsgScript())
            installLog.appendLine("Git hooks installed")

            // Install Claude Code skill file (.claude/skills/jolli-recall/SKILL.md)
            SkillInstaller(mainRepoRoot).updateSkillIfNeeded()
            installLog.appendLine("Skill installed")

            // Write install log
            writeInstallLog(installLog.toString())

            return InstallResult(true, "JolliMemory hooks installed successfully", warnings)
        } catch (e: Exception) {
            installLog.appendLine("ERROR: ${e.message}\n${e.stackTraceToString()}")
            writeInstallLog(installLog.toString())
            return InstallResult(false, "Installation failed: ${e.message}", warnings)
        }
    }

    private fun writeInstallLog(content: String) {
        try {
            val logFile = File(System.getProperty("user.home") + "/.jolli/logs", "jollimemory-install-debug.log").also { it.parentFile.mkdirs() }
            logFile.writeText("=== Install Log ===\n${java.time.Instant.now()}\n\n$content")
        } catch (_: Exception) { }
    }

    /**
     * Remove all hooks.
     */
    fun uninstall(): InstallResult {
        try {
            removeClaudeHook()
            removeGeminiHook()
            removeGitHookSection("post-commit", POST_COMMIT_START, POST_COMMIT_END)
            removeGitHookSection("post-rewrite", POST_REWRITE_START, POST_REWRITE_END)
            removeGitHookSection("prepare-commit-msg", PREPARE_MSG_START, PREPARE_MSG_END)
            return InstallResult(true, "JolliMemory hooks removed", emptyList())
        } catch (e: Exception) {
            return InstallResult(false, "Uninstallation failed: ${e.message}", emptyList())
        }
    }

    // ── Claude Code Hook ────────────────────────────────────────────────────

    private fun installClaudeHook() {
        val settingsDir = File(mainRepoRoot, ".claude")
        settingsDir.mkdirs()
        val settingsFile = File(settingsDir, "settings.local.json")

        val hooksJar = findHooksJar()
        val javaPath = resolveJavaPath()

        val settings: JsonObject = if (settingsFile.exists()) {
            try {
                JsonParser.parseString(settingsFile.readText(Charsets.UTF_8)).asJsonObject
            } catch (_: Exception) {
                JsonObject()
            }
        } else {
            JsonObject()
        }

        // Build hooks.Stop entry
        val hooks = settings.getAsJsonObject("hooks") ?: JsonObject().also { settings.add("hooks", it) }

        // Check if already installed with correct path
        val stopArray = hooks.getAsJsonArray("Stop") ?: com.google.gson.JsonArray().also { hooks.add("Stop", it) }
        if (hooksJar != null) {
            val hookCommand = """"$javaPath" -jar "$hooksJar" stop"""

            // Remove ALL existing JolliMemory entries (Node.js or Kotlin variants)
            val iterator = stopArray.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.isJsonObject) {
                    val text = entry.toString()
                    if (text.contains("JolliMemory") || text.contains("StopHook") || text.contains("jollimemory-hooks")) {
                        iterator.remove()
                    }
                }
            }

            // Add new entry
            val hookEntry = JsonObject()
            val hooksArray = com.google.gson.JsonArray()
            val hookDef = JsonObject().apply {
                addProperty("type", "command")
                addProperty("command", hookCommand)
                addProperty("async", true)
            }
            hooksArray.add(hookDef)
            hookEntry.add("hooks", hooksArray)
            stopArray.add(hookEntry)
        }

        settingsFile.writeText(gson.toJson(settings))
    }

    private fun removeClaudeHook() {
        val settingsFile = File(mainRepoRoot, ".claude/settings.local.json")
        if (!settingsFile.exists()) return

        try {
            val settings = JsonParser.parseString(settingsFile.readText(Charsets.UTF_8)).asJsonObject
            val hooks = settings.getAsJsonObject("hooks") ?: return
            val stopArray = hooks.getAsJsonArray("Stop") ?: return

            val iterator = stopArray.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                val text = entry.toString()
                if (text.contains("StopHook") || text.contains("JolliMemory") || text.contains("jollimemory-hooks")) {
                    iterator.remove()
                }
            }

            if (stopArray.isEmpty) hooks.remove("Stop")
            settingsFile.writeText(gson.toJson(settings))
        } catch (_: Exception) { }
    }

    // ── Gemini CLI Hook ────────────────────────────────────────────────────

    /**
     * Installs the JolliMemory AfterAgent hook into `.gemini/settings.json`.
     *
     * Matches the VS Code extension's Gemini hook format:
     * ```json
     * { "hooks": { "AfterAgent": [{ "hooks": [{ "type": "command", "command": "..." }] }] } }
     * ```
     *
     * Uses the JAR-based command (`java -jar jollimemory-hooks.jar gemini-after-agent`)
     * instead of Node.js, consistent with all other IntelliJ plugin hooks.
     */
    private fun installGeminiHook() {
        val settingsDir = File(projectDir, ".gemini")
        settingsDir.mkdirs()
        val settingsFile = File(settingsDir, "settings.json")

        val hooksJar = findHooksJar()
        val javaPath = resolveJavaPath()

        val settings: JsonObject = if (settingsFile.exists()) {
            try {
                JsonParser.parseString(settingsFile.readText(Charsets.UTF_8)).asJsonObject
            } catch (_: Exception) {
                JsonObject()
            }
        } else {
            JsonObject()
        }

        val hooks = settings.getAsJsonObject("hooks") ?: JsonObject().also { settings.add("hooks", it) }
        val afterAgentArray = hooks.getAsJsonArray("AfterAgent")
            ?: com.google.gson.JsonArray().also { hooks.add("AfterAgent", it) }

        if (hooksJar != null) {
            val hookCommand = """"$javaPath" -jar "$hooksJar" gemini-after-agent"""

            // Remove existing JolliMemory entries (Node.js or Kotlin variants)
            val iterator = afterAgentArray.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.isJsonObject) {
                    val text = entry.toString()
                    if (text.contains("JolliMemory") || text.contains("jollimemory") ||
                        text.contains("GeminiAfterAgentHook") || text.contains("jollimemory-hooks")
                    ) {
                        iterator.remove()
                    }
                }
            }

            // Add new matcher group entry (matches VS Code format)
            val hookEntry = JsonObject()
            val hooksArray = com.google.gson.JsonArray()
            val hookDef = JsonObject().apply {
                addProperty("type", "command")
                addProperty("command", hookCommand)
                addProperty("name", "jollimemory-session-tracker")
            }
            hooksArray.add(hookDef)
            hookEntry.add("hooks", hooksArray)
            afterAgentArray.add(hookEntry)
        }

        settingsFile.writeText(gson.toJson(settings))
    }

    private fun removeGeminiHook() {
        val settingsFile = File(projectDir, ".gemini/settings.json")
        if (!settingsFile.exists()) return

        try {
            val settings = JsonParser.parseString(settingsFile.readText(Charsets.UTF_8)).asJsonObject
            val hooks = settings.getAsJsonObject("hooks") ?: return
            val afterAgentArray = hooks.getAsJsonArray("AfterAgent") ?: return

            val iterator = afterAgentArray.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                val text = entry.toString()
                if (text.contains("JolliMemory") || text.contains("jollimemory") ||
                    text.contains("GeminiAfterAgentHook") || text.contains("jollimemory-hooks")
                ) {
                    iterator.remove()
                }
            }

            if (afterAgentArray.isEmpty) hooks.remove("AfterAgent")
            if (hooks.entrySet().isEmpty()) settings.remove("hooks")
            settingsFile.writeText(gson.toJson(settings))
        } catch (_: Exception) { }
    }

    /**
     * Finds or extracts the jollimemory-hooks.jar file.
     *
     * The JAR is bundled inside the IntelliJ plugin. On first use, it's extracted
     * to ~/.jolli/bin/jollimemory-hooks.jar so hook scripts can reference a stable path.
     */
    private fun findHooksJar(): String? {
        val home = System.getProperty("user.home")
        val binDir = File("$home/.jolli/bin")
        val installed = File(binDir, "jollimemory-hooks.jar")

        // 1. Find in plugin's lib directory and always copy to ~/.jolli/bin/ (keeps it up to date)
        val pluginJar = findPluginLibJar()
        if (pluginJar != null) {
            try {
                binDir.mkdirs()
                pluginJar.copyTo(installed, overwrite = true)
                log.info("Copied hooks JAR from plugin lib to: %s", installed.absolutePath)
                return installed.absolutePath
            } catch (e: Exception) {
                log.info("Failed to copy hooks JAR: %s", e.message)
                return pluginJar.absolutePath
            }
        }

        // 2. Already at ~/.jolli/bin/ from a previous install
        if (installed.exists()) return installed.absolutePath

        // 3. Fallback: dev build output
        val devPaths = listOf(
            File(projectDir, "tools/jollimemory-intellij/build/libs"),
            File(mainRepoRoot, "tools/jollimemory-intellij/build/libs"),
        )
        for (devBuild in devPaths) {
            if (devBuild.isDirectory) {
                val jar = devBuild.listFiles()?.firstOrNull {
                    it.name.startsWith("jollimemory-hooks") && it.name.endsWith(".jar")
                }
                if (jar != null) return jar.absolutePath
            }
        }

        log.info("jollimemory-hooks.jar not found")
        return null
    }

    /** Finds jollimemory-hooks.jar using IntelliJ's Plugin API to locate the plugin directory. */
    private fun findPluginLibJar(): File? {
        val searchLog = StringBuilder()
        return try {
            // Use IntelliJ Plugin API to find our plugin's installation path.
            // This will throw NoClassDefFoundError when running from the hooks JAR
            // (outside IntelliJ), which is caught below.
            val pluginId = com.intellij.openapi.extensions.PluginId.getId("ai.jolli.jollimemory")
            searchLog.appendLine("pluginId=$pluginId")

            val plugin = com.intellij.ide.plugins.PluginManagerCore.getPlugin(pluginId)
            searchLog.appendLine("plugin=${plugin?.name} version=${plugin?.version}")

            val pluginPath = plugin?.pluginPath
            searchLog.appendLine("pluginPath=$pluginPath")

            if (pluginPath != null) {
                val libDir = pluginPath.resolve("lib").toFile()
                searchLog.appendLine("libDir=${libDir.absolutePath} exists=${libDir.exists()}")

                if (libDir.isDirectory) {
                    val files = libDir.listFiles()?.map { it.name } ?: emptyList()
                    searchLog.appendLine("libDir contents: $files")

                    val candidate = File(libDir, "jollimemory-hooks.jar")
                    if (candidate.exists()) {
                        searchLog.appendLine("FOUND: ${candidate.absolutePath}")
                        writeSearchLog(searchLog.toString())
                        return candidate
                    }
                }

                // Walk entire plugin directory
                val pluginDir = pluginPath.toFile()
                searchLog.appendLine("Walking plugin dir: ${pluginDir.absolutePath}")
                val found = pluginDir.walkTopDown().maxDepth(5)
                    .firstOrNull { it.name == "jollimemory-hooks.jar" }
                if (found != null) {
                    searchLog.appendLine("FOUND via walk: ${found.absolutePath}")
                    writeSearchLog(searchLog.toString())
                    return found
                }
            }

            searchLog.appendLine("NOT FOUND")
            writeSearchLog(searchLog.toString())
            null
        } catch (e: Throwable) {
            // Catches both Exception AND NoClassDefFoundError (when running outside IntelliJ)
            searchLog.appendLine("EXCEPTION: ${e.javaClass.simpleName}: ${e.message}")
            writeSearchLog(searchLog.toString())
            null
        }
    }

    private fun writeSearchLog(content: String) {
        try {
            File(System.getProperty("user.home") + "/.jolli/logs", "jollimemory-jar-search.log").also { it.parentFile.mkdirs() }
                .writeText("=== JAR Search Log ===\n${java.time.Instant.now()}\n\n$content")
        } catch (_: Exception) { }
    }

    /** Resolves the java binary path (IntelliJ bundled JDK or system). */
    private fun resolveJavaPath(): String {
        // IntelliJ's bundled JDK
        val javaHome = System.getProperty("java.home")
        if (javaHome != null) {
            val javaBin = File("$javaHome/bin/java")
            if (javaBin.exists()) return javaBin.absolutePath
        }
        return "java"
    }

    // ── Git Hooks ───────────────────────────────────────────────────────────

    private fun installGitHook(hookName: String, startMarker: String, endMarker: String, script: String) {
        val hooksDir = File(resolveGitDir(), "hooks")
        hooksDir.mkdirs()
        val hookFile = File(hooksDir, hookName)

        var content = if (hookFile.exists()) hookFile.readText(Charsets.UTF_8) else "#!/bin/sh\n"

        // Ensure shebang
        if (!content.startsWith("#!")) {
            content = "#!/bin/sh\n$content"
        }

        // Remove existing section if present
        content = removeBetweenMarkers(content, startMarker, endMarker)

        // Append new section
        content = content.trimEnd() + "\n\n$startMarker\n$script\n$endMarker\n"

        hookFile.writeText(content)
        hookFile.setExecutable(true)
    }

    private fun removeGitHookSection(hookName: String, startMarker: String, endMarker: String) {
        val hookFile = File(resolveGitDir(), "hooks/$hookName")
        if (!hookFile.exists()) return

        val content = hookFile.readText(Charsets.UTF_8)
        val cleaned = removeBetweenMarkers(content, startMarker, endMarker).trim()

        // If only shebang remains, delete the file
        if (cleaned == "#!/bin/sh" || cleaned.isBlank()) {
            hookFile.delete()
        } else {
            hookFile.writeText(cleaned + "\n")
        }
    }

    private fun removeBetweenMarkers(content: String, startMarker: String, endMarker: String): String {
        val startIdx = content.indexOf(startMarker)
        val endIdx = content.indexOf(endMarker)
        if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return content
        return content.substring(0, startIdx) + content.substring(endIdx + endMarker.length)
    }

    // ── Hook script templates ───────────────────────────────────────────────
    // Shell scripts that delegate to the Kotlin fat JAR.
    // No Node.js needed — only JDK (bundled with IntelliJ).

    private fun postCommitScript(): String {
        val jar = findHooksJar() ?: return "echo 'jollimemory-hooks.jar not found' >&2"
        val java = resolveJavaPath()
        return """"$java" -jar "$jar" post-commit "$@" &"""
    }

    private fun postRewriteScript(): String {
        val jar = findHooksJar() ?: return "echo 'jollimemory-hooks.jar not found' >&2"
        val java = resolveJavaPath()
        return """"$java" -jar "$jar" post-rewrite "$@""""
    }

    private fun prepareMsgScript(): String {
        val jar = findHooksJar() ?: return "echo 'jollimemory-hooks.jar not found' >&2"
        val java = resolveJavaPath()
        return """"$java" -jar "$jar" prepare-commit-msg "$@""""
    }
}

data class InstallResult(
    val success: Boolean,
    val message: String,
    val warnings: List<String>,
)
