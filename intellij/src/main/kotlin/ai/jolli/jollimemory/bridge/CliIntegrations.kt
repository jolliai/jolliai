package ai.jolli.jollimemory.bridge

import com.google.gson.JsonParser
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

    /**
     * True when `<projectDir>/.mcp.json` registers the jollimemory MCP server at a
     * command that can no longer be spawned — specifically the Windows form
     * `node <abs Cli.js>` whose Cli.js no longer exists on disk. That happens when the
     * dist that won dist-path selection at registration time was later removed (e.g. a
     * VS Code extension uninstall) and nothing re-registered since, leaving a dead
     * `.mcp.json` the AI host fails to launch.
     *
     * The version stamp alone can't catch this: the registration goes stale from an
     * environment change (another surface uninstalled), not a plugin-version change, so
     * [integrationsUpToDate] stays true and startup would otherwise never re-register.
     * Used as an extra re-enable trigger alongside the version gate — one healing
     * re-enable re-resolves `.mcp.json` to a live dist (the CLI also prunes the ghost
     * dist-paths entry as part of that enable).
     *
     * The POSIX form registers the `run-cli` dispatch script (indirection that
     * re-resolves at spawn time and never goes stale), so this only fires on the
     * baked-absolute-path Windows form. Pure file I/O — no node — so it's cheap on every
     * startup. Returns false when there is no `.mcp.json`, no jollimemory entry, the
     * entry isn't the `node <Cli.js>` form, or its Cli.js still exists.
     */
    fun mcpRegistrationStale(projectDir: String): Boolean {
        val f = File(projectDir, ".mcp.json")
        if (!f.exists()) return false
        return try {
            val root = JsonParser.parseString(f.readText(Charsets.UTF_8)).asJsonObject
            val server = root.getAsJsonObject("mcpServers")?.getAsJsonObject("jollimemory") ?: return false
            val command = server.get("command")?.asString ?: return false
            // POSIX form uses the run-cli dispatch script (never stales); only the Windows
            // `node <Cli.js>` form bakes an absolute path that can point at a removed dist.
            if (!command.equals("node", ignoreCase = true)) return false
            val cliJs = server.getAsJsonArray("args")?.firstOrNull()?.asString ?: return false
            !File(cliJs).exists()
        } catch (_: Exception) {
            false
        }
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
     * Absolute path to a VERIFIED `node` executable, or null if none exists. Delegates
     * to [NodeRuntime], which probes the process/login/interactive-shell PATHs plus
     * well-known install dirs, proves candidates with `node --version`, and records the
     * winner in `~/.jolli/jollimemory/node-info.json`. Blocking on first call — keep
     * off the EDT (all current callers already run on pooled threads).
     */
    fun resolveNode(): String? = NodeRuntime.detect()?.path

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
     * Best-effort catch-up for the pre-push memory sync (JOLLI-1900). Spawns the
     * bundled `PrePushWorker.js` to drain `push-pending.json` to Jolli Space. Two
     * callers:
     *   - plugin startup ([JolliMemoryService.initialize]) — fire-and-forget, for
     *     commits left pending by an offline push in a previous session;
     *   - the post-commit drain ([PostCommitHook.drainWorker], `waitForCompletion=true`)
     *     — the IntelliJ analog of the TS `QueueWorker.triggerPushForNewSummaries`,
     *     so a push that raced ahead of summary generation syncs as soon as the
     *     summary lands, without waiting for the next plugin start.
     *
     * Cheap pre-check: returns immediately when there is no `push-pending.json`
     * (`PushPendingStore` unlinks the file when it's empty), so the common commit —
     * nothing pending — never pays a Node spawn.
     *
     * Never throws: a missing worker, absent Node, non-git dir, or offline network
     * just leaves the pending entries for the next trigger. The worker self-no-ops
     * when the user isn't signed in.
     *
     * @param waitForCompletion when true, block (bounded) until the drain worker
     *   exits — safe here because the caller is already a detached background
     *   process (git has returned); ensures the push finishes within the caller's
     *   lifetime instead of orphaning the child when the JVM exits.
     */
    fun retryPendingPushes(projectDir: String, waitForCompletion: Boolean = false) {
        try {
            // Nothing pending → skip without spawning Node (the hot path for a
            // normal commit). PushPendingStore removes the file when it's empty,
            // so mere existence means there is at least one entry to try.
            val pending = File(projectDir, ".jolli/jollimemory/push-pending.json")
            if (!pending.exists() || pending.length() == 0L) return

            val node = resolveNode() ?: return
            val worker = File(distIntellijDir(), "PrePushWorker.js")
            if (!worker.exists()) return
            val proc = ProcessBuilder(node, worker.absolutePath, "--cwd", projectDir)
                .directory(File(projectDir))
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            if (waitForCompletion) {
                if (!proc.waitFor(120, TimeUnit.SECONDS)) proc.destroyForcibly()
            }
            log.info("Ran pre-push retry worker for %s (wait=%s)", projectDir, waitForCompletion)
        } catch (e: Exception) {
            log.warn("Pre-push retry spawn failed (non-fatal): %s", e.message)
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
