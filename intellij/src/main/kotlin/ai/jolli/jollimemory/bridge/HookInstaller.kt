package ai.jolli.jollimemory.bridge

import com.google.gson.GsonBuilder
import com.google.gson.JsonParser
import ai.jolli.jollimemory.core.JmLogger
import java.io.File

/**
 * Installs and removes JolliMemory hooks by delegating to the plugin-bundled CLI.
 *
 * `install()` runs the CLI's FULL `enable` ([CliIntegrations.enableFull]): the five
 * git hooks (post-commit, post-rewrite, prepare-commit-msg, post-merge, pre-push —
 * all Node `run-hook` dispatcher scripts), the Claude Stop/SessionStart hooks, the
 * Gemini AfterAgent hook, skills, global instructions, MCP registration, and the
 * dispatch scripts. `uninstall()` runs the full `disable`. The plugin no longer
 * writes any hook body itself — the former Kotlin fat-JAR pipeline
 * (`java -jar jollimemory-hooks.jar ...`) is gone, so commits are summarized by the
 * same CLI QueueWorker as the CLI and VS Code surfaces.
 *
 * What stays Kotlin-side:
 *   - detection: the CLI's GitHookInstaller uses the exact same section markers, so
 *     hooks installed by ANY surface (including a legacy fat-JAR body, which a full
 *     enable replaces in place) are recognized;
 *   - legacy-entry cleanup: agent-hook entries the old fat-JAR install wrote into
 *     Claude/Gemini settings are NOT matched by the CLI's identifier lists
 *     ("run-hook"/"StopHook"/"GeminiAfterAgentHook" — the legacy command contains
 *     none of them verbatim as a command marker), so they are removed here before
 *     enable to prevent DOUBLE hooks after an upgrade;
 *   - legacy git-hook body pre-flight: [detectLegacyGitHookBodies] scans the five
 *     tracked git hook files for `jollimemory-hooks.jar` references and logs which
 *     ones are about to be replaced. Does NOT modify the files — the CLI enable's
 *     marker-scoped in-place replace does that cleanly (identical section markers +
 *     [resolveGitHooksDir] resolving worktrees to the main repo's `hooks/`), so the
 *     retired `java -jar` command line disappears with the section body itself. The
 *     scan is observability: an upgrade path that would otherwise be silent becomes
 *     visible in the install log;
 *   - the `.gitignore` guard for `.jolli/` (cheap and idempotent).
 *
 * Worktree-aware legacy uninstall: on `.git`-file worktrees the CLI's
 * `resolveGitHooksDir` follows `gitdir:` back to the main repo's shared `hooks/`,
 * so the marker-scoped replace runs against the same set of files regardless of
 * which worktree opens the project. No separate per-worktree teardown pass is
 * needed — main-repo replace fans out to every worktree because they all share
 * that hooks directory.
 *
 * The old `~/.jolli/bin/jollimemory-hooks.jar` file is deliberately NOT deleted:
 * other repositories may still carry legacy hook bodies pointing at it until they
 * are re-enabled (their post-merge-less hook set fails [areAllHooksInstalled], which
 * triggers auto-install on their next open).
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
     *
     * Also respects two explicit user opt-outs so we don't fight the project's
     * own choice: a negation line (`!.jolli/`) and a commented-out entry
     * (`# .jolli/`). In either case we leave the file untouched — the CLI's
     * enable path will still refuse to write anything sensitive if the user
     * really did want `.jolli/` tracked.
     */
    private fun ensureGitignoreEntry(projectRoot: String) {
        val gitignore = File(projectRoot, ".gitignore")
        val entry = ".jolli/"
        if (gitignore.exists()) {
            val content = gitignore.readText(Charsets.UTF_8)
            val alreadyCovered = content.lines().any { raw ->
                val trimmed = raw.trim()
                val effective = trimmed.removePrefix("#").trim().removePrefix("!").trim()
                effective == entry || effective == ".jolli"
            }
            if (alreadyCovered) return
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
        private const val POST_REWRITE_START = "# >>> JolliMemory post-rewrite hook >>>"
        private const val PREPARE_MSG_START = "# >>> JolliMemory prepare-commit-msg hook >>>"
        private const val POST_MERGE_START = "# >>> JolliMemory post-merge hook >>>"
        private const val PRE_PUSH_START = "# >>> JolliMemory pre-push hook >>>"

        /** Marker of the retired fat-JAR hook variant inside agent settings entries. */
        private const val LEGACY_JAR_MARKER = "jollimemory-hooks"

        /**
         * Substrings identifying a JolliMemory entry inside Claude's hooks.Stop array.
         * Mirrors the CLI's STOP_HOOK_IDENTIFIERS ("run-hook" for the current dispatcher
         * entry — its command is `"$HOME/.jolli/jollimemory/run-hook" stop`, which contains
         * none of the older markers — and "StopHook" for the legacy direct-node form);
         * LEGACY_JAR_MARKER adds the retired fat-JAR form so pre-CLI installs are still
         * recognized before their upgrade.
         */
        private val CLAUDE_HOOK_IDENTIFIERS = listOf("run-hook", "StopHook", LEGACY_JAR_MARKER)
    }

    /**
     * Check if the Claude Code Stop hook is installed.
     *
     * Reads `projectDir/.claude/settings.local.json` — NOT `mainRepoRoot`. The CLI's
     * enable path runs with `.directory(projectDir)` and no `--cwd`, so its own
     * `resolveProjectDir()` (git rev-parse --show-toplevel) returns the CURRENT
     * worktree and it writes the Stop hook there. Detecting from `mainRepoRoot`
     * would keep this false forever on a linked worktree — the startup gate
     * (`cachedStatus?.enabled != true`) would then rerun a full enable on every
     * open. On the main checkout `projectDir == mainRepoRoot` so nothing changes.
     */
    fun isClaudeHookInstalled(): Boolean {
        val settingsPath = File(projectDir, ".claude/settings.local.json")
        if (!settingsPath.exists()) return false
        return try {
            val settings = JsonParser.parseString(settingsPath.readText(Charsets.UTF_8)).asJsonObject
            val stopArray = settings.getAsJsonObject("hooks")?.getAsJsonArray("Stop") ?: return false
            // Match per Stop entry (not against the whole file) so unrelated settings
            // content can't produce a false positive, mirroring the CLI's matcher helpers.
            stopArray.any { entry ->
                val text = entry.toString()
                CLAUDE_HOOK_IDENTIFIERS.any { text.contains(it) }
            }
        } catch (_: Exception) {
            false
        }
    }

    /** Returns debug info about paths being checked. */
    fun getDebugInfo(): String {
        val gitDir = resolveGitDir()
        val claudePath = File(projectDir, ".claude/settings.local.json")
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

    /**
     * Check all required hooks. post-merge is part of the set: legacy fat-JAR installs
     * never wrote it, so they fail this check and the startup auto-install upgrades
     * them to the CLI-managed Node hooks (same markers — replaced in place).
     *
     * @param claudeRequired pass false when the user explicitly disabled Claude
     *   (config.claudeEnabled == false): the CLI's enable skips the Claude hook then,
     *   so requiring it here would flag a complete install as broken and re-trigger
     *   the startup auto-install on every project open. Mirrors the CLI's own
     *   isFullyInstalled readiness check (`claudeReady = claudeEnabled === false || …`).
     */
    fun areAllHooksInstalled(claudeRequired: Boolean = true): Boolean {
        return (!claudeRequired || isClaudeHookInstalled()) && areAllGitHooksInstalled()
    }

    /** Check all five CLI-installed git hook sections. */
    fun areAllGitHooksInstalled(): Boolean {
        return isGitHookInstalled("post-commit", POST_COMMIT_START) &&
            isGitHookInstalled("post-rewrite", POST_REWRITE_START) &&
            isGitHookInstalled("prepare-commit-msg", PREPARE_MSG_START) &&
            isGitHookInstalled("post-merge", POST_MERGE_START) &&
            isGitHookInstalled("pre-push", PRE_PUSH_START)
    }

    /**
     * Install all hooks by running the bundled CLI's full `enable`.
     * Returns a result message.
     */
    fun install(): InstallResult {
        val installLog = StringBuilder()
        try {
            // Ensure .jolli/jollimemory directory
            File(projectDir, ".jolli/jollimemory").mkdirs()
            installLog.appendLine("Created .jolli/jollimemory dir")

            // Ensure .jolli/ is in the project's .gitignore to prevent API key leakage
            ensureGitignoreEntry(projectDir)
            installLog.appendLine("Checked .gitignore for .jolli/ entry")

            // Drop agent-hook entries written by the retired fat-JAR install BEFORE
            // enable — the CLI's identifier lists don't match them, so without this an
            // upgraded install would end up with double Stop/AfterAgent hooks.
            val removedLegacy = removeLegacyAgentHookEntries()
            installLog.appendLine("Legacy fat-JAR agent entries removed: $removedLegacy")

            // Log any legacy fat-JAR git-hook bodies about to be swept out. The CLI's
            // enable replaces the marker section in place (same markers as the retired
            // Kotlin install wrote), so we only need visibility, not a separate teardown.
            val legacyGitHooks = detectLegacyGitHookBodies()
            if (legacyGitHooks.isNotEmpty()) {
                log.info("Legacy fat-JAR git hook bodies detected (replaced in place by CLI enable): %s", legacyGitHooks)
                installLog.appendLine("Legacy fat-JAR git hooks detected: $legacyGitHooks")
            }

            // The CLI owns ALL hook installation: git hooks + Claude + Gemini + skills
            // + global instructions + MCP + dispatch scripts, in one transaction-ish run.
            val result = CliIntegrations.enableFull(projectDir)
            installLog.appendLine("CLI full enable result: $result")
            installLog.appendLine("claudeHook=${isClaudeHookInstalled()} gitHooks5=${areAllGitHooksInstalled()}")
            writeInstallLog(installLog.toString())

            return when (result) {
                is CliIntegrations.Result.Ok ->
                    InstallResult(true, "JolliMemory hooks installed successfully", emptyList())
                else ->
                    InstallResult(
                        false,
                        CliIntegrations.warningFor(result) ?: "enable failed",
                        emptyList(),
                    )
            }
        } catch (e: Exception) {
            installLog.appendLine("ERROR: ${e.message}\n${e.stackTraceToString()}")
            writeInstallLog(installLog.toString())
            return InstallResult(false, "Installation failed: ${e.message}", emptyList())
        }
    }

    private fun writeInstallLog(content: String) {
        try {
            val logFile = File(System.getProperty("user.home") + "/.jolli/logs", "jollimemory-install-debug.log").also { it.parentFile.mkdirs() }
            logFile.writeText("=== Install Log ===\n${java.time.Instant.now()}\n\n$content")
        } catch (_: Exception) { }
    }

    /**
     * Ensures the node integrations (MCP + skills + bundled Cli.js) are set up for the
     * CURRENT plugin version WITHOUT touching hooks. Called on startup so a plugin
     * upgrade activates them without a manual re-enable — `install()` doesn't re-run
     * once hooks are already installed. Idempotent + version-gated; node-only.
     *
     * Beyond the version gate, this also re-runs when the project's `.mcp.json` points
     * the jollimemory server at a `node <Cli.js>` path that no longer exists (see
     * [CliIntegrations.mcpRegistrationStale]). Such a dead registration comes from an
     * environment change — another surface's dist being removed — not a plugin-version
     * change, so the version stamp can't catch it; one re-enable re-resolves `.mcp.json`
     * to a live dist.
     *
     * @return a human-readable warning when integrations could not be set up (Node missing,
     *   bundle missing, or the CLI failed) so the caller can notify, or `null` when they are
     *   already up to date or were set up successfully.
     */
    fun ensureIntegrations(): String? {
        if (CliIntegrations.integrationsUpToDate() && !CliIntegrations.mcpRegistrationStale(projectDir)) return null
        return CliIntegrations.warningFor(CliIntegrations.enableIntegrations(projectDir))
    }

    /**
     * Remove all hooks by running the bundled CLI's full `disable` (git hook sections —
     * same markers regardless of which surface wrote them, including legacy fat-JAR
     * bodies — plus Claude/Gemini agent hooks and the repo-scoped MCP registration).
     */
    fun uninstall(): InstallResult {
        return try {
            // Legacy fat-JAR agent entries are invisible to the CLI's identifier lists —
            // sweep them here so a disable leaves nothing behind.
            removeLegacyAgentHookEntries()
            when (val result = CliIntegrations.disableFull(projectDir)) {
                is CliIntegrations.Result.Ok -> InstallResult(true, "JolliMemory hooks removed", emptyList())
                else -> InstallResult(
                    false,
                    CliIntegrations.warningFor(result) ?: "disable failed",
                    emptyList(),
                )
            }
        } catch (e: Exception) {
            InstallResult(false, "Uninstallation failed: ${e.message}", emptyList())
        }
    }

    // ── Legacy fat-JAR entry cleanup ────────────────────────────────────────

    /**
     * Scans the five tracked git-hook files (`post-commit`, `post-rewrite`,
     * `prepare-commit-msg`, `post-merge`, `pre-push`) for `jollimemory-hooks.jar`
     * references written by the retired Kotlin fat-JAR install. Returns the hook
     * names whose bodies still contain such a reference — the CLI's enable will
     * replace those marker sections in place immediately after.
     *
     * Read-only by design: the CLI enable's marker-scoped in-place replace already
     * takes care of removal, and doing another edit here would fight with it.
     * Worktree-aware via [resolveGitDir], which follows `gitdir:` back to the main
     * repo's shared `hooks/` — so the same set of files is scanned regardless of
     * which worktree the plugin opens the project in.
     */
    internal fun detectLegacyGitHookBodies(): List<String> {
        val hooksDir = File(resolveGitDir(), "hooks")
        if (!hooksDir.isDirectory) return emptyList()
        val hookNames = listOf("post-commit", "post-rewrite", "prepare-commit-msg", "post-merge", "pre-push")
        return hookNames.filter { name ->
            val file = File(hooksDir, name)
            if (!file.isFile) return@filter false
            try {
                file.readText(Charsets.UTF_8).contains(LEGACY_JAR_MARKER)
            } catch (_: Exception) {
                false
            }
        }
    }

    /**
     * Removes agent-hook entries written by the retired Kotlin fat-JAR install
     * (`java -jar .../jollimemory-hooks.jar stop|gemini-after-agent`) from the Claude
     * and Gemini settings files. Matches ONLY the `jollimemory-hooks` marker — the
     * CLI-written entries (`.jolli/jollimemory/run-hook ...`) never contain it, so
     * this can never remove a current hook. Returns true when anything was removed.
     */
    internal fun removeLegacyAgentHookEntries(): Boolean {
        var removed = false
        // Claude settings live at projectDir/.claude/... to match where the CLI's
        // enable writes them (its `resolveProjectDir()` is `git rev-parse
        // --show-toplevel`, which returns the current worktree). A linked worktree
        // could carry a legacy fat-JAR entry here from a pre-CLI install, and
        // scanning `mainRepoRoot` would miss it.
        removed = removeLegacyEntriesFrom(File(projectDir, ".claude/settings.local.json"), "Stop") || removed
        removed = removeLegacyEntriesFrom(File(projectDir, ".gemini/settings.json"), "AfterAgent") || removed
        return removed
    }

    /** Strips legacy fat-JAR entries from one settings file's hooks.<event> array. */
    private fun removeLegacyEntriesFrom(settingsFile: File, eventKey: String): Boolean {
        if (!settingsFile.exists()) return false
        return try {
            val settings = JsonParser.parseString(settingsFile.readText(Charsets.UTF_8)).asJsonObject
            val hooks = settings.getAsJsonObject("hooks") ?: return false
            val eventArray = hooks.getAsJsonArray(eventKey) ?: return false

            var removed = false
            val iterator = eventArray.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.isJsonObject && entry.toString().contains(LEGACY_JAR_MARKER)) {
                    iterator.remove()
                    removed = true
                }
            }
            if (!removed) return false

            if (eventArray.isEmpty) hooks.remove(eventKey)
            if (hooks.entrySet().isEmpty()) settings.remove("hooks")
            settingsFile.writeText(gson.toJson(settings))
            log.info("Removed legacy fat-JAR entries from %s (%s)", settingsFile.name, eventKey)
            true
        } catch (e: Exception) {
            log.warn("Legacy entry cleanup failed for %s: %s", settingsFile.absolutePath, e.message)
            false
        }
    }
}

data class InstallResult(
    val success: Boolean,
    val message: String,
    val warnings: List<String>,
    /**
     * Human-readable reason MCP + skills were not set up (Node missing, bundle missing, or
     * the bundled CLI failed), or `null` when they succeeded. With the CLI owning the whole
     * enable, a failure now fails the install as a whole — this stays for API compatibility
     * and for the startup catch-up path's notifications.
     */
    val integrationsIssue: String? = null,
)
