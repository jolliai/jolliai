package ai.jolli.jollimemory.bridge

import com.google.gson.JsonParser
import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Process boundary to the plugin-bundled, self-contained CLI (`cli-dist/Cli.js`).
 * Domain behavior, git hooks, MCP, skills and shared stores are CLI-owned; Kotlin
 * callers serialize DTOs and retain only IntelliJ lifecycle/UI responsibilities.
 * Node is therefore a startup requirement, not an optional MCP-only dependency.
 */
object CliIntegrations {

    private val log = JmLogger.create("CliIntegrations")

    private const val IDE_BRIDGE_TIMEOUT_SECONDS = 300L

    sealed class Result {
        /** Integrations set up successfully. */
        object Ok : Result()

		/** Node is not on PATH — CLI-backed functionality cannot start. */
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
			"Node.js 22.5 or newer was not found — CLI-backed memory, MCP, /jolli-recall and /jolli-search are unavailable. " +
				"Install Node.js and reopen the project."
        is Result.BundleMissing ->
            "MCP and skills could not be set up — the bundled CLI was not found in the plugin. " +
                "Try reinstalling the Jolli Memory plugin."
        is Result.Failed ->
			"CLI integrations failed to set up: ${result.message}. " +
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

    /**
     * Records a successful enable by stamping the current plugin version.
     *
     * The write is atomic (temp sibling + [java.nio.file.Files.move] with
     * ATOMIC_MOVE) so a concurrent reader — [CliDaemonClient.currentDistVersion]
     * runs on every daemon call() — can never observe a half-truncated stamp.
     * Without this, a reader that landed inside `writeText`'s truncate window
     * would compare the daemon's cached distVersion against `""`, decide the
     * daemon was stale, tear it down, and pull every in-flight future with it.
     */
    internal fun markIntegrationsEnabled(distDir: File) {
        try {
            val stamp = File(distDir, ".version")
            val tmp = File(
                distDir,
                ".version.tmp.${System.currentTimeMillis()}.${ProcessHandle.current().pid()}",
            )
            tmp.writeText(readPluginVersion())
            try {
                java.nio.file.Files.move(
                    tmp.toPath(),
                    stamp.toPath(),
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE,
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
            } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
                // Fall back to a non-atomic replace on filesystems that don't
                // support atomic moves (e.g. cross-device). The concurrent-read
                // window opens back up here, but this branch is exceedingly rare
                // (dist dir lives under $HOME so same-fs the vast majority of
                // the time) — the atomic path is what matters day to day.
                java.nio.file.Files.move(
                    tmp.toPath(),
                    stamp.toPath(),
                    java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                )
            } finally {
                // If move succeeded, the temp file no longer exists — this delete
                // is a best-effort cleanup for the fallback branch that may
                // leave the temp behind on some errors.
                tmp.delete()
            }
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
            //
            // OS-level file lock: two IntelliJ projects opening at once in the same
            // JVM (Recent Projects) both call extractCliDist() and both loop-copy
            // into the SAME dist directory. `copyTo(overwrite=true)` is not
            // atomic — an interleaved truncation can leave a partially-written
            // Cli.js that then breaks the very daemon that ran the copy. The
            // lock serialises the whole extraction, so the second project waits
            // for the first to finish and then sees a valid dist.
            val lockFile = File(distDir, ".extract.lock").apply { createNewFile() }
            java.io.RandomAccessFile(lockFile, "rw").use { raf ->
                raf.channel.use { chan ->
                    chan.lock().use { _ ->
                        val n = srcDir.listFiles { f -> f.isFile && f.name.endsWith(".js") }
                            ?.onEach { it.copyTo(File(distDir, it.name), overwrite = true) }
                            ?.size ?: 0
                        log.info("Extracted bundled CLI dist (%d files) to %s", n, distDir.absolutePath)
                    }
                }
            }
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
    fun enableIntegrations(projectDir: String): Result =
        runEnable(projectDir, listOf("enable", "--integrations-only", "--source-tag", "intellij"), "integrations enable")

    /**
     * FULL enable: the CLI installs EVERYTHING — the five git hooks (post-commit,
     * post-rewrite, prepare-commit-msg, post-merge, pre-push, all as Node `run-hook`
     * dispatcher scripts), the Claude Stop/SessionStart hooks, the Gemini AfterAgent
     * hook, skills, global instructions, MCP registration, and dispatch scripts.
     * This replaced the plugin's own Kotlin fat-JAR hook installation: the CLI's
     * GitHookInstaller uses the exact same section markers, so it replaces a legacy
     * `java -jar` hook body in place. `--yes` keeps the run non-interactive.
     */
    fun enableFull(projectDir: String): Result =
        runEnable(projectDir, listOf("enable", "--yes", "--source-tag", "intellij"), "full enable")

    /** Shared enable runner — spawns the bundled CLI and stamps the version on success. */
    private fun runEnable(projectDir: String, args: List<String>, label: String): Result {
        val node = resolveNode() ?: return Result.NodeMissing
        val distDir = extractCliDist() ?: return Result.BundleMissing
        val cliJs = File(distDir, "Cli.js")
        return try {
            val proc = ProcessBuilder(listOf(node, cliJs.absolutePath) + args)
                .directory(File(projectDir))
                .redirectErrorStream(true)
                .start()
            val out = proc.inputStream.bufferedReader().use { it.readText() }
            if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                return Result.Failed("$label timed out")
            }
            if (proc.exitValue() == 0) {
                // Stamp "enabled" ONLY now — after a confirmed success — so a later failure
                // or an interrupted run is never mistaken for a completed one. A full enable
                // is a superset of the integrations-only enable, so it stamps too.
                markIntegrationsEnabled(distDir)
                log.info("Bundled CLI %s succeeded", label)
                Result.Ok
            } else {
                clearIntegrationsEnabled(distDir)
                log.warn("Bundled CLI %s exited %d: %s", label, proc.exitValue(), out.take(500))
                Result.Failed("exit ${proc.exitValue()}")
            }
        } catch (e: Exception) {
            clearIntegrationsEnabled(distDir)
            log.error("Failed to run bundled CLI %s: %s", label, e.message)
            Result.Failed(e.message ?: "unknown")
        }
    }

    /**
     * Wall-clock budget for one interactive `generate` call. Generous because the
     * local-agent provider drives a full agent turn (Claude Code CLI) which can take
     * minutes; API/proxy calls finish far sooner and never hit this.
     */
    private const val GENERATE_TIMEOUT_SECONDS = 300L

    /**
     * How often the cancellation poll checks [ProgressIndicator.isCanceled] while
     * waiting for the child. Short enough that a user hitting Cancel in the
     * progress bar sees the process die within a beat; long enough not to burn
     * CPU. The wait itself is 500 ms so the overall timeout is still measured in
     * seconds regardless of poll frequency.
     */
    private const val GENERATE_CANCEL_POLL_MS = 500L

    /**
     * Runs one `jolli generate <action>` bridge call against the bundled CLI and
     * returns the parsed success JSON. This is how the plugin's interactive AI
     * features (commit message, squash message, E2E guide, recap, translate) reach
     * the CLI's `callLlm` — including the local-agent provider, which the Kotlin
     * LLM stack never supported.
     *
     * Contract (see cli/src/commands/GenerateCommand.ts): [requestJson] is written
     * to the child's stdin (null → empty body); the response is a single JSON line
     * on stdout — `{"type":"<action>", …}` on success, `{"type":"error", …}` on
     * failure. stdout is redirected to a temp file so a large response (e.g. a
     * translated document) can never fill the pipe and deadlock against [waitFor].
     *
     * When [indicator] is provided, the wait polls [ProgressIndicator.isCanceled]
     * every [GENERATE_CANCEL_POLL_MS] and destroys the child if the user cancels —
     * without this, a local-agent invocation (which drives a full Claude Code turn
     * and can take minutes) would keep running under the retired progress bar,
     * eating CPU and API budget for a result no one will see.
     *
     * Throws [RuntimeException] with a user-facing message on ANY failure (Node
     * missing, bundle missing, timeout, CLI error) — callers surface `ex.message`
     * in their existing error dialogs. Cancellation surfaces as
     * [ProcessCanceledException], the standard IntelliJ signal the caller's
     * `Task.Backgroundable` swallows silently.
     */
    fun generate(
        projectDir: String,
        action: String,
        requestJson: String?,
        indicator: com.intellij.openapi.progress.ProgressIndicator? = null,
    ): com.google.gson.JsonObject {
        val node = resolveNode()
            ?: throw RuntimeException(
                "Node.js not found — it is required for AI generation. Install Node.js and reopen the project.",
            )
        // Reuse the already-extracted dist (kept fresh by the startup enable's version
        // gate); extract only when it is missing entirely (e.g. wiped ~/.jolli).
        val distDir = distIntellijDir().takeIf { File(it, "Cli.js").exists() }
            ?: extractCliDist()
            ?: throw RuntimeException("The bundled CLI was not found in the plugin. Try reinstalling the Jolli Memory plugin.")
        val cliJs = File(distDir, "Cli.js")

        val outFile = File.createTempFile("jolli-generate-", ".json")
        try {
            val proc = ProcessBuilder(node, cliJs.absolutePath, "generate", action, "--cwd", projectDir)
                .directory(File(projectDir))
                .redirectOutput(outFile)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            proc.outputStream.use { stdin ->
                if (requestJson != null) stdin.write(requestJson.toByteArray(Charsets.UTF_8))
            }
            awaitGenerateProcess(proc, indicator)
            val stdout = outFile.readText(Charsets.UTF_8)
            return parseGenerateResponse(stdout, action, proc.exitValue())
        } finally {
            outFile.delete()
        }
    }

    /**
     * Waits for [proc] to exit, honouring [ProgressIndicator.isCanceled] and the
     * overall [GENERATE_TIMEOUT_SECONDS] budget. Split out so tests can exercise
     * the wait shape independently of process spawning.
     */
    private fun awaitGenerateProcess(
        proc: Process,
        indicator: com.intellij.openapi.progress.ProgressIndicator?,
    ) {
        val deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(GENERATE_TIMEOUT_SECONDS)
        while (true) {
            if (indicator?.isCanceled == true) {
                proc.destroyForcibly()
                throw com.intellij.openapi.progress.ProcessCanceledException()
            }
            if (proc.waitFor(GENERATE_CANCEL_POLL_MS, TimeUnit.MILLISECONDS)) return
            if (System.nanoTime() > deadlineNanos) {
                proc.destroyForcibly()
                throw RuntimeException("AI generation timed out after ${GENERATE_TIMEOUT_SECONDS}s")
            }
        }
    }

    /**
     * Parses the `generate` stdout contract. Split out for direct testing — the
     * response is the LAST non-blank line so stray output from the Node runtime
     * (e.g. experimental-feature warnings that leak onto stdout) cannot break it.
     */
    internal fun parseGenerateResponse(stdout: String, action: String, exitValue: Int): com.google.gson.JsonObject {
        val line = stdout.lineSequence().lastOrNull { it.isNotBlank() }
            ?: throw RuntimeException("AI generation produced no output (exit $exitValue)")
        val obj = try {
            JsonParser.parseString(line).asJsonObject
        } catch (_: Exception) {
            throw RuntimeException("AI generation returned unreadable output (exit $exitValue): ${line.take(200)}")
        }
        if (obj.get("type")?.asString == "error") {
            val message = obj.get("message")?.asString ?: "unknown error"
            throw RuntimeException(friendlyLlmMessage(obj.get("errorName")?.asString, message))
        }
        if (exitValue != 0) {
            throw RuntimeException("AI generation failed (exit $exitValue)")
        }
        log.info("generate %s succeeded", action)
        return obj
    }

    /**
     * Runs one hidden `jolli ide-bridge <action>` JSON request. Domain behavior
     * stays in `cli/src`; Kotlin callers only serialize DTOs and consume the
     * returned `result` element.
     */
    fun runIdeBridge(
        projectDir: String,
        action: String,
        requestJson: String? = null,
        timeoutSeconds: Long = IDE_BRIDGE_TIMEOUT_SECONDS,
    ): com.google.gson.JsonElement {
        // Prefer the long-lived daemon when the caller's project has one bound.
        // A daemon call is ~5-20ms vs a one-shot spawn's ~500ms-2s cold start,
        // so this shift is what pulls hot-path bridge reads (config-load,
        // status, session-state, etc.) below IntelliJ's 300ms slow-EDT floor.
        // A real business-logic error propagates as [CliBridgeException] —
        // same shape as before so callers up the stack don't care which path
        // ran. Any local failure (daemon crashed, protocol mismatch, socket
        // broke) is logged and falls through to the legacy one-shot spawn so
        // the request still completes.
        // PERF DIAGNOSTICS: time both paths so debug.log shows which one served each call.
        val startNanos = System.nanoTime()
        val daemon = findDaemonForCwd(projectDir)
        if (daemon != null) {
            try {
                val result = daemon.call(action, projectDir, requestJson, timeoutSeconds)
                log.info("runIdeBridge action=%s path=daemon took=%dms", action, (System.nanoTime() - startNanos) / 1_000_000)
                return result
            } catch (e: CliBridgeException) {
                throw e
            } catch (e: CliDaemonClient.CliDaemonTimeoutException) {
                // Timeout means the daemon is STILL running the action. A
                // one-shot fallback would spawn a second Node process that
                // starts the same action fresh, so a side-effectful op
                // (sync push, store-summary, force-push) would run twice.
                // Surface the timeout instead — the daemon's own guarantee
                // is the same as the legacy one-shot path once the wait
                // budget is exhausted.
                throw e
            } catch (e: Exception) {
                log.warn("CLI daemon call failed, falling back to one-shot spawn: %s", e.message)
            }
        } else {
            // Normal path when no daemon is registered for this cwd yet (e.g. a request
            // that arrives before the daemon channel has attached, or for a worktree the
            // daemon doesn't cover). Log at info; real failures still warn above.
            log.info("runIdeBridge action=%s no daemon matched cwd=%s — falling back to one-shot spawn", action, projectDir)
        }
        val node = resolveNode()
            ?: throw RuntimeException("Node.js not found — it is required for Jolli Memory. Install Node.js and reopen the project.")
        val cliJs = resolveCliJs()
            ?: throw RuntimeException("The bundled CLI was not found in the plugin. Try reinstalling Jolli Memory.")
        val outFile = File.createTempFile("jolli-ide-bridge-", ".json")
        try {
            val proc = ProcessBuilder(node, cliJs.absolutePath, "ide-bridge", action, "--cwd", projectDir)
                .directory(File(projectDir))
                .redirectOutput(outFile)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            proc.outputStream.use { stdin ->
                if (requestJson != null) stdin.write(requestJson.toByteArray(Charsets.UTF_8))
            }
            if (!proc.waitFor(timeoutSeconds, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                throw RuntimeException("CLI bridge action '$action' timed out after ${timeoutSeconds}s")
            }
            val line = outFile.readText(Charsets.UTF_8).lineSequence().lastOrNull { it.isNotBlank() }
                ?: throw RuntimeException("CLI bridge action '$action' produced no output (exit ${proc.exitValue()})")
            val obj = try {
                JsonParser.parseString(line).asJsonObject
            } catch (_: Exception) {
                throw RuntimeException("CLI bridge action '$action' returned unreadable output: ${line.take(200)}")
            }
            // JSON-RPC 2.0 wire: success has `result`, failure has `error: {code, message, data}`.
            val errorObj = obj.get("error")?.takeIf { it.isJsonObject }?.asJsonObject
            if (errorObj != null) {
                val data = errorObj.get("data")?.takeIf { it.isJsonObject }?.asJsonObject
                    ?: com.google.gson.JsonObject()
                throw CliBridgeException(
                    data.get("errorName")?.takeUnless { it.isJsonNull }?.asString,
                    errorObj.get("message")?.asString ?: "unknown CLI bridge error",
                    data,
                )
            }
            if (proc.exitValue() != 0) {
                throw RuntimeException("CLI bridge action '$action' failed (exit ${proc.exitValue()})")
            }
            log.info("runIdeBridge action=%s path=one-shot took=%dms", action, (System.nanoTime() - startNanos) / 1_000_000)
            return obj.get("result") ?: com.google.gson.JsonNull.INSTANCE
        } finally {
            outFile.delete()
        }
    }

    /**
     * Locates a working `Cli.js` by the same 4-step chain the one-shot bridge
     * has always used: installed plugin dist → workspace dev checkout → the
     * previously-extracted intellij dist → freshly re-extract from the plugin
     * jar. Consolidated here so [runIdeBridge] and [CliDaemonClient] use one
     * lookup and can never drift.
     */
    internal fun resolveCliJs(): File? =
        resolveBundledCliJs()
            ?: resolveDevelopmentCliJs()
            ?: File(distIntellijDir(), "Cli.js").takeIf { it.exists() }
            ?: extractCliDist()?.let { File(it, "Cli.js") }

    /**
     * Unit tests and local Gradle runs execute classes outside an installed plugin,
     * so there is no `<plugin>/cli-dist`. Reuse the freshly built workspace CLI in
     * that environment. Installed plugins always resolve [resolveBundledCliJs]
     * first and never enter this development-only lookup.
     */
    private fun resolveDevelopmentCliJs(): File? {
        val workingDir = File(System.getProperty("user.dir"))
        return sequenceOf(
            File(workingDir, "cli/dist/Cli.js"),
            File(workingDir, "../cli/dist/Cli.js"),
        ).firstOrNull { it.isFile }
    }

    /**
     * Locates the [CliDaemonClient] whose project owns [projectDir], or null
     * when no matching open Project has a daemon service attached.
     *
     * A project has TWO valid "cwds": `project.basePath` (where IntelliJ was
     * pointed) and the main git worktree root the plugin resolved during
     * startup (`JolliMemoryService.mainRepoRoot`). These two can be
     * completely disjoint filesystem paths when the IDE opened a *linked*
     * worktree — the mainRepoRoot is `.../repo` while basePath is
     * `.../repo-feature`, and neither is a prefix of the other. Every
     * hot-path caller in the audit passes `service.mainRepoRoot ?: basePath`,
     * so we must be able to match either form; otherwise the daemon quietly
     * falls through to one-shot spawns for the majority of clicks.
     *
     * Matching per candidate: direct canonical equality, then either-way
     * prefix containment (covers a caller cwd that is a subdirectory of the
     * project root, and the rarer reverse). We use `getServiceIfCreated` to
     * read `mainRepoRoot` — creating JolliMemoryService here would trigger
     * its heavy `initialize()` from an ide-bridge call, which is not the
     * responsibility of this cheap lookup.
     *
     * A no-match returns null so [runIdeBridge] falls through to the
     * one-shot spawn path without incident.
     */
    private fun findDaemonForCwd(projectDir: String): CliDaemonClient? {
        if (projectDir.isBlank()) return null
        val cwdCanon = runCatching { File(projectDir).canonicalPath }.getOrNull() ?: return null
        val projects = try {
            com.intellij.openapi.project.ProjectManager.getInstance().openProjects
        } catch (_: Throwable) {
            // ProjectManager not ready (very early startup) — one-shot spawn works.
            return null
        }
        for (project in projects) {
            if (project.isDisposed) continue
            val candidates = buildList {
                project.basePath?.let { add(it) }
                mainRepoRootOf(project)?.let { add(it) }
            }
            for (raw in candidates) {
                val candidate = runCatching { File(raw).canonicalPath }.getOrNull() ?: continue
                val matches = candidate == cwdCanon ||
                    cwdCanon.startsWith(candidate + File.separator) ||
                    candidate.startsWith(cwdCanon + File.separator)
                if (!matches) continue
                return runCatching { project.getService(CliDaemonClient::class.java) }.getOrNull()
            }
        }
        return null
    }

    /**
     * Returns a directory that [findDaemonForCwd] can match against an open
     * project so global-scope bridge calls (auth token load, global config
     * read, KB path resolve, KB repo discovery, summary-tree read) reach the
     * daemon's ~5-20 ms fast path instead of falling through to the ~500 ms
     * one-shot Node spawn.
     *
     * These callers have no natural project context (they run from global
     * singletons or from actions whose event has no project) yet the request
     * itself does not depend on which project answers — it reads global
     * config or an explicit `dir` inside the request payload. Any open
     * project's daemon will serve them identically.
     *
     * Preference order: first non-disposed open project's canonical
     * basePath; else `System.getProperty("user.dir")`, preserving the
     * pre-daemon behavior when no project is open yet.
     */
    fun resolveDefaultCwd(): String {
        val projects = try {
            com.intellij.openapi.project.ProjectManager.getInstance().openProjects
        } catch (_: Throwable) {
            emptyArray()
        }
        for (project in projects) {
            if (project.isDisposed) continue
            val base = project.basePath ?: continue
            val canon = runCatching { File(base).canonicalPath }.getOrNull() ?: continue
            return canon
        }
        return System.getProperty("user.dir")
    }

    /**
     * Reads the JolliMemoryService's mainRepoRoot without forcing service
     * creation. If the service has not been instantiated yet (very early
     * startup) we return null and let the caller consider only basePath.
     */
    private fun mainRepoRootOf(project: com.intellij.openapi.project.Project): String? {
        return try {
            val cls = ai.jolli.jollimemory.services.JolliMemoryService::class.java
            // `getServiceIfCreated` returns null when the service isn't already
            // bound — safer than `getService`, which would trigger its heavy
            // initialize() from an ide-bridge call.
            project.getServiceIfCreated(cls)?.mainRepoRoot
        } catch (_: Throwable) {
            null
        }
    }

    /**
     * User-facing text for a classified CLI generation failure. The CLI tags its
     * error JSON with `errorName` (see cli/src/commands/GenerateCommand.ts); the
     * local-agent auth failure gets sign-in guidance because its raw message
     * ("Not logged in · Please run /login") assumes an open claude session the
     * user doesn't have. Every dialog surfacing `ex.message` benefits — the
     * mapping happens once, at the parse choke point.
     */
    private fun friendlyLlmMessage(errorName: String?, message: String): String = when (errorName) {
        "LocalAgentAuthError" ->
            "Claude Code is installed but not signed in. Open a terminal, run `claude`, " +
                "and sign in with /login — or switch the AI provider in Jolli Memory settings."
        else -> message
    }

    /** Result of one `jolli migrate-memory-bank` run — the subset the UI status lines need. */
    data class MigrationBridgeResult(
        val status: String,
        val migratedEntries: Int,
        val totalEntries: Int,
    )

    /**
     * Wall-clock budget for one Memory Bank migration. Generous because a first
     * migration on a large repo copies every summary / transcript / plan / note
     * from the orphan branch onto disk; the steady-state stale-child reconcile
     * finishes in well under a second.
     */
    private const val MIGRATE_TIMEOUT_SECONDS = 300L

    /**
     * Runs the orphan-branch → Memory Bank folder migration via the bundled CLI's
     * hidden `migrate-memory-bank` command (see
     * cli/src/commands/MigrateMemoryBankCommand.ts). The CLI is the sole migration
     * implementation: it resolves the Memory Bank root from the shared config,
     * runs the full migration when it has not completed yet, and otherwise runs
     * the idempotent stale-child reconcile — matching the VS Code activate path.
     *
     * The command needs no stdin and prints a single JSON line on stdout —
     * `{"type":"migrate-memory-bank","status":…,"migratedEntries":…,"totalEntries":…}`
     * on success, `{"type":"error", …}` on failure. stdout is redirected to a temp
     * file so a chatty migration log can never fill the pipe and deadlock [waitFor].
     *
     * Throws [RuntimeException] with a user-facing message on ANY failure (Node
     * missing, bundle missing, timeout, CLI error) — callers surface `ex.message`.
     */
    fun migrateMemoryBank(projectDir: String): MigrationBridgeResult {
        val node = resolveNode()
            ?: throw RuntimeException(
                "Node.js not found — it is required for Memory Bank migration. Install Node.js and reopen the project.",
            )
        val distDir = distIntellijDir().takeIf { File(it, "Cli.js").exists() }
            ?: extractCliDist()
            ?: throw RuntimeException("The bundled CLI was not found in the plugin. Try reinstalling the Jolli Memory plugin.")
        val cliJs = File(distDir, "Cli.js")

        val outFile = File.createTempFile("jolli-migrate-", ".json")
        try {
            val proc = ProcessBuilder(node, cliJs.absolutePath, "migrate-memory-bank", "--cwd", projectDir)
                .directory(File(projectDir))
                .redirectOutput(outFile)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
                .start()
            if (!proc.waitFor(MIGRATE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                throw RuntimeException("Memory Bank migration timed out after ${MIGRATE_TIMEOUT_SECONDS}s")
            }
            return parseMigrateResponse(outFile.readText(Charsets.UTF_8), proc.exitValue())
        } finally {
            outFile.delete()
        }
    }

    /**
     * Parses the `migrate-memory-bank` stdout contract. Split out for direct
     * testing — the response is the LAST non-blank line so stray Node runtime
     * output (e.g. experimental-feature warnings) cannot break it.
     */
    internal fun parseMigrateResponse(stdout: String, exitValue: Int): MigrationBridgeResult {
        val line = stdout.lineSequence().lastOrNull { it.isNotBlank() }
            ?: throw RuntimeException("Memory Bank migration produced no output (exit $exitValue)")
        val obj = try {
            JsonParser.parseString(line).asJsonObject
        } catch (_: Exception) {
            throw RuntimeException("Memory Bank migration returned unreadable output (exit $exitValue): ${line.take(200)}")
        }
        if (obj.get("type")?.asString == "error") {
            // Preserve the CLI's classified errorName so downstream dialogs can
            // route on the same key runIdeBridge already surfaces (e.g. auth
            // failures) instead of degrading to a generic RuntimeException.
            throw CliBridgeException(
                obj.get("errorName")?.takeUnless { it.isJsonNull }?.asString,
                obj.get("message")?.asString ?: "unknown error",
            )
        }
        if (exitValue != 0) {
            throw RuntimeException("Memory Bank migration failed (exit $exitValue)")
        }
        val status = obj.get("status")?.asString ?: "unknown"
        val migrated = obj.get("migratedEntries")?.asInt ?: 0
        val total = obj.get("totalEntries")?.asInt ?: 0
        log.info("migrate-memory-bank succeeded: %s (%d/%d)", status, migrated, total)
        return MigrationBridgeResult(status, migrated, total)
    }

    /**
     * Best-effort catch-up for the pre-push memory sync (JOLLI-1900). Spawns the
     * bundled `PrePushWorker.js` to drain `push-pending.json` to Jolli Space.
     * Called from plugin startup (`JolliMemoryService.initialize`) — fire-and-forget,
     * for commits left pending by an offline push in a previous session. The
     * post-commit-time drain is the CLI QueueWorker's own job now that the git hooks
     * run the CLI pipeline (`QueueWorker.triggerPushForNewSummaries`).
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
    fun disableIntegrations(projectDir: String): Result =
        runDisable(projectDir, listOf("disable", "--integrations-only"), "integrations disable")

    /**
     * FULL disable: the CLI removes the git hook sections (same markers regardless of
     * which surface wrote them, including legacy `java -jar` bodies), the Claude and
     * Gemini agent hooks, and the repo-scoped MCP registration. Global MCP entries
     * stay, per the CLI's conservative uninstall policy.
     */
    fun disableFull(projectDir: String): Result =
        runDisable(projectDir, listOf("disable"), "full disable")

    /** Shared disable runner — spawns the bundled CLI; never touches the version stamp. */
    private fun runDisable(projectDir: String, args: List<String>, label: String): Result {
        val node = resolveNode() ?: return Result.NodeMissing
        val distDir = extractCliDist() ?: return Result.BundleMissing
        val cliJs = File(distDir, "Cli.js")
        return try {
            val proc = ProcessBuilder(listOf(node, cliJs.absolutePath) + args)
                .directory(File(projectDir))
                .redirectErrorStream(true)
                .start()
            proc.inputStream.bufferedReader().use { it.readText() }
            if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                return Result.Failed("$label timed out")
            }
            if (proc.exitValue() == 0) Result.Ok else Result.Failed("exit ${proc.exitValue()}")
        } catch (e: Exception) {
            log.warn("Failed to run bundled CLI %s (non-fatal): %s", label, e.message)
            Result.Failed(e.message ?: "unknown")
        }
    }

    class CliBridgeException(
        val errorName: String?,
        message: String,
        val details: com.google.gson.JsonObject = com.google.gson.JsonObject(),
    ) : RuntimeException(message)
}
