package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * CliIntegrations — lights up MCP + skills for an IntelliJ-only install by shelling
 * out to the plugin-bundled, self-contained CLI (`cli-dist/Cli.js`, an esbuild bundle
 * with all deps inlined — no node_modules).
 *
 * The plugin runs its own Java git hooks and generates memory without Node, so it does
 * NOT install Node hooks. But the MCP server (`jolli mcp`) and the recall/search/pr
 * skills are inherently Node programs — the only way to provide them is a Node runtime.
 * So this reuses the CLI's own `enable --integrations-only` (dispatch scripts +
 * dist-paths + MCP registration + skills, NO hooks) instead of re-porting all of that
 * to Kotlin.
 *
 * Node is required only at MCP/skill run time (in the AI host) — and here, at enable
 * time, to run the setup. When Node is absent, this is a clean no-op-with-signal:
 * memory generation keeps working via the Java hooks; the caller notifies the user.
 */
object CliIntegrations {

    private val log = JmLogger.create("CliIntegrations")
    private val isWindows = System.getProperty("os.name").lowercase().contains("win")

    sealed class Result {
        /** Integrations set up successfully. */
        object Ok : Result()

        /** Node is not on PATH — integrations skipped (memory generation still works). */
        object NodeMissing : Result()

        /** The bundled Cli.js could not be located (packaging problem). */
        object BundleMissing : Result()

        /** The bundled CLI ran but failed. */
        data class Failed(val message: String) : Result()
    }

    /**
     * Human-readable warning for a non-successful integrations result, or `null` when
     * everything is fine ([Result.Ok]). Centralized here so the install path and the
     * startup catch-up path surface identical wording (balloon + StatusPanel tooltip).
     */
    fun warningFor(result: Result): String? = when (result) {
        is Result.Ok -> null
        is Result.NodeMissing ->
            "Node.js not found — the MCP tools and the /jolli-search and /jolli-pr skills were skipped. " +
                "Memory generation still works (native hooks). Install Node.js and reopen the project to activate them."
        is Result.BundleMissing ->
            "MCP and skills could not be set up — the bundled CLI was not found in the plugin. " +
                "Try reinstalling the Jolli Memory plugin."
        is Result.Failed ->
            "MCP and skills failed to set up: ${result.message}. Memory generation still works. " +
                "See ~/.jolli/logs/jollimemory-install-debug.log for details."
    }

    /**
     * Locates the installed plugin's root directory. Tries the class's codeSource
     * first, then falls back to parsing a bundled resource's URL — because on newer
     * IntelliJ (2026.1+) `protectionDomain.codeSource.location` is null for plugin
     * classes under the module classloader, which broke the codeSource-only lookup.
     */
    fun resolvePluginDir(): File? {
        // Strategy 1: codeSource → …/<plugin>/lib/<jar>.jar → <plugin>
        try {
            val loc = javaClass.protectionDomain?.codeSource?.location
            if (loc != null) {
                val jar = File(loc.toURI())
                val dir = jar.parentFile?.parentFile
                if (dir != null && dir.isDirectory) return dir
            }
        } catch (_: Throwable) {
            // fall through to the resource-URL strategy
        }
        // Strategy 2: a bundled resource's URL → jar path → plugin dir. getResource works
        // even when codeSource.location is null (it's how readPluginVersion already reads).
        try {
            val url = javaClass.getResource("/jollimemory-plugin-version.txt") ?: return null
            val s = url.toString()
            when {
                // jar:file:/…/<plugin>/lib/<jar>.jar!/jollimemory-plugin-version.txt
                s.startsWith("jar:") -> {
                    val jar = File(java.net.URI(s.removePrefix("jar:").substringBefore("!/")))
                    val dir = jar.parentFile?.parentFile
                    if (dir != null && dir.isDirectory) return dir
                }
                // file:/…/<plugin>/classes/… (sandbox/unpacked) — climb to the dir holding cli-dist/bin
                s.startsWith("file:") -> {
                    var d: File? = File(java.net.URI(s.substringBefore("!/"))).parentFile
                    repeat(6) {
                        val cur = d
                        if (cur != null && (File(cur, "cli-dist").isDirectory || File(cur, "bin").isDirectory)) return cur
                        d = cur?.parentFile
                    }
                }
            }
        } catch (e: Throwable) {
            log.warn("resolvePluginDir fallback failed: %s", e.message)
        }
        return null
    }

    /** The extracted-CLI directory that `dist-paths/intellij` points at. */
    internal fun distIntellijDir(): File =
        File(System.getProperty("user.home"), ".jolli/jollimemory/dist-intellij")

    /**
     * True when integrations were **successfully enabled** for the CURRENT plugin version.
     * The `.version` stamp is written ONLY after [enableIntegrations] returns [Result.Ok]
     * (see [markIntegrationsEnabled]) — NOT when the bundle is merely extracted. That
     * distinction matters: a failed `enable` (skills/MCP not written) must not look "done",
     * otherwise startup never retries it and the StatusPanel shows a false "active".
     * Lets startup skip re-running node on every launch, but re-run after an upgrade or a
     * previous failure.
     */
    fun integrationsUpToDate(): Boolean = integrationsUpToDate(distIntellijDir())

    /** Testable seam: same predicate against an explicit dist dir. */
    internal fun integrationsUpToDate(distDir: File): Boolean {
        val stamp = File(distDir, ".version")
        return File(distDir, "Cli.js").exists() && stamp.exists() && stamp.readText().trim() == readPluginVersion()
    }

    /** Records a successful enable by stamping the current plugin version. */
    internal fun markIntegrationsEnabled(distDir: File) {
        try {
            File(distDir, ".version").writeText(readPluginVersion())
        } catch (e: Exception) {
            log.warn("Failed to write integrations version stamp: %s", e.message)
        }
    }

    /** Clears the enabled stamp so the next startup retries `enable`. */
    internal fun clearIntegrationsEnabled(distDir: File) {
        try {
            File(distDir, ".version").delete()
        } catch (_: Exception) {
            // best-effort — a stale stamp only means one extra retry
        }
    }

    /** Resolves the plugin-bundled `cli-dist/Cli.js`. */
    fun resolveBundledCliJs(): File? {
        val dir = resolvePluginDir() ?: return null
        val candidate = File(dir, "cli-dist/Cli.js")
        if (candidate.exists()) return candidate
        // Non-standard layout fallback: walk for cli-dist/Cli.js.
        return dir.walkTopDown().maxDepth(5)
            .firstOrNull { it.name == "Cli.js" && it.parentFile?.name == "cli-dist" }
    }

    /**
     * Extracts the bundled Cli.js to `~/.jolli/jollimemory/dist-intellij/` (version-gated
     * on the plugin version) and returns that dist directory. `dist-paths/intellij` will
     * point here after [enableIntegrations] runs.
     */
    fun extractCliDist(): File? {
        val cliJs = resolveBundledCliJs() ?: return null
        val srcDir = cliJs.parentFile ?: return null // the bundled cli-dist directory
        val distDir = distIntellijDir()
        return try {
            distDir.mkdirs()
            // Copy the WHOLE dist (Cli.js + the per-hook entry scripts) so this dist also
            // satisfies `run-hook`, not just `run-cli`/MCP/skills. This runs only from
            // [enableIntegrations]/[disableIntegrations] (i.e. when NOT already enabled),
            // so an unconditional overwrite is off the hot path. Deliberately writes NO
            // version stamp — the stamp means "enable succeeded" and is written by
            // [markIntegrationsEnabled] only after the enable subprocess returns Ok.
            val n = srcDir.listFiles { f -> f.isFile && f.name.endsWith(".js") }
                ?.onEach { it.copyTo(File(distDir, it.name), overwrite = true) }
                ?.size ?: 0
            log.info("Extracted bundled CLI dist (%d files) to %s", n, distDir.absolutePath)
            distDir
        } catch (e: Exception) {
            log.error("Failed to extract bundled CLI: %s", e.message)
            null
        }
    }

    private fun readPluginVersion(): String =
        try {
            javaClass.getResourceAsStream("/jollimemory-plugin-version.txt")
                ?.bufferedReader()?.use { it.readText().trim() } ?: "dev"
        } catch (_: Exception) {
            "dev"
        }

    /**
     * The user's login-shell PATH. GUI-launched IDEs inherit a minimal PATH that often
     * omits node installed via nvm/homebrew, so we ask the login shell (matches
     * PrService's gh resolution).
     */
    private val resolvedPath: String by lazy {
        try {
            if (isWindows) {
                System.getenv("PATH") ?: ""
            } else {
                val shell = System.getenv("SHELL")?.takeIf { it.isNotBlank() && File(it).canExecute() } ?: "/bin/zsh"
                val proc = ProcessBuilder(shell, "-l", "-c", "echo \$PATH").redirectErrorStream(true).start()
                val out = proc.inputStream.bufferedReader().use { it.readText().trim() }
                proc.waitFor(5, TimeUnit.SECONDS)
                if (out.isNotBlank()) out else System.getenv("PATH") ?: ""
            }
        } catch (_: Exception) {
            System.getenv("PATH") ?: ""
        }
    }

    /** Absolute path to a `node` executable on the login-shell PATH, or null if absent. */
    fun resolveNode(): String? {
        val candidates = if (isWindows) listOf("node.exe", "node.cmd", "node") else listOf("node")
        for (dir in resolvedPath.split(File.pathSeparator)) {
            if (dir.isBlank()) continue
            for (name in candidates) {
                val f = File(dir, name)
                if (f.canExecute()) return f.absolutePath
            }
        }
        return null
    }

    fun isNodeAvailable(): Boolean = resolveNode() != null

    /**
     * Sets up MCP + skills by running the bundled CLI's `enable --integrations-only`
     * (tagged `intellij` so its dist-paths entry coexists with any CLI/VS Code install).
     * Returns [Result.NodeMissing] when Node is absent — a clean skip, not an error.
     */
    fun enableIntegrations(projectDir: String): Result {
        val node = resolveNode() ?: return Result.NodeMissing
        val distDir = extractCliDist() ?: return Result.BundleMissing
        val cliJs = File(distDir, "Cli.js")
        return try {
            val proc = ProcessBuilder(
                node, cliJs.absolutePath, "enable", "--integrations-only", "--source-tag", "intellij",
            )
                .directory(File(projectDir))
                .redirectErrorStream(true)
                .start()
            val out = proc.inputStream.bufferedReader().use { it.readText() }
            if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                return Result.Failed("integrations enable timed out")
            }
            if (proc.exitValue() == 0) {
                // Stamp "enabled" ONLY now — after a confirmed success — so a later failure
                // or an interrupted run is never mistaken for a completed one.
                markIntegrationsEnabled(distDir)
                log.info("Integrations enabled via bundled CLI")
                Result.Ok
            } else {
                clearIntegrationsEnabled(distDir)
                log.warn("Integrations enable exited %d: %s", proc.exitValue(), out.take(500))
                Result.Failed("exit ${proc.exitValue()}")
            }
        } catch (e: Exception) {
            clearIntegrationsEnabled(distDir)
            log.error("Failed to run integrations enable: %s", e.message)
            Result.Failed(e.message ?: "unknown")
        }
    }

    /**
     * Tears down the MCP registration via `disable --integrations-only` (best-effort).
     * No-op when Node or the bundle is missing — nothing to undo that we could reach.
     */
    fun disableIntegrations(projectDir: String): Result {
        val node = resolveNode() ?: return Result.NodeMissing
        val distDir = extractCliDist() ?: return Result.BundleMissing
        val cliJs = File(distDir, "Cli.js")
        return try {
            val proc = ProcessBuilder(node, cliJs.absolutePath, "disable", "--integrations-only")
                .directory(File(projectDir))
                .redirectErrorStream(true)
                .start()
            proc.inputStream.bufferedReader().use { it.readText() }
            if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                return Result.Failed("integrations disable timed out")
            }
            if (proc.exitValue() == 0) Result.Ok else Result.Failed("exit ${proc.exitValue()}")
        } catch (e: Exception) {
            log.warn("Failed to run integrations disable (non-fatal): %s", e.message)
            Result.Failed(e.message ?: "unknown")
        }
    }
}
