package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.TraceContext
import com.google.gson.Gson
import com.google.gson.JsonObject
import com.google.gson.JsonParser
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

    /**
     * Tighter timeout for enable/disable — install typically completes in
     * 500 ms–2 s and never legitimately runs for minutes. Matches the retired
     * subprocess path's `proc.waitFor(60, TimeUnit.SECONDS)` so a stuck daemon
     * fails within one minute instead of after the default 5-minute ceiling.
     */
    private const val INSTALL_BRIDGE_TIMEOUT_SECONDS = 60L

    /**
     * Name of the plugin-version stamp written after a successful [extractCliDist]
     * copy. Sibling of the enable-success `.version` stamp but with a different
     * meaning: this one just says "the on-disk `*.js` files are byte-identical to
     * the bundled ones for this plugin version" and survives disable, so a later
     * Enable click can skip the 50-300 ms lock-guarded copy on the hot path.
     */
    private const val EXTRACT_STAMP_FILE = ".extract-stamp"

    /** Shared serializer for bridge payloads — no HTML escaping needed, no need for pretty printing. */
    private val gson = Gson()

    /**
     * Creates an owner-only temp file (POSIX 0600) so a response containing
     * credentials — the `handle-auth-callback` response carries `token` and
     * `jolliApiKey` — is not readable by other local users while the process
     * is alive. `File.createTempFile` follows the JDK's default `O_CREAT` +
     * umask path, which on shared-`/tmp` Linux hosts (unlike macOS's per-user
     * `$TMPDIR` at 0700) leaves the file 0644 for the delete window.
     *
     * The `generate` and `migrate-memory-bank` responses do not contain
     * credentials, but they can carry private summary / transcript content —
     * same helper for consistency and to keep the choice one place.
     *
     * Windows: `PosixFilePermissions` throws `UnsupportedOperationException`
     * there — fall back to `File.createTempFile`. Windows's default temp dir
     * (`%LOCALAPPDATA%\Temp`) is already per-user via NTFS ACLs.
     */
    internal fun createSecureTempFile(prefix: String, suffix: String): File {
        return try {
            val perms = java.util.EnumSet.of(
                java.nio.file.attribute.PosixFilePermission.OWNER_READ,
                java.nio.file.attribute.PosixFilePermission.OWNER_WRITE,
            )
            val attr = java.nio.file.attribute.PosixFilePermissions.asFileAttribute(perms)
            java.nio.file.Files.createTempFile(prefix, suffix, attr).toFile()
        } catch (_: UnsupportedOperationException) {
            // Windows or a non-POSIX filesystem — user-scoped temp dir already
            // restricts access at the ACL layer.
            File.createTempFile(prefix, suffix)
        }
    }

    sealed class Result {
        /** Integrations set up successfully. */
        object Ok : Result()

		/** Node is not on PATH — CLI-backed functionality cannot start. */
        object NodeMissing : Result()

        /** The bundled Cli.js could not be located (packaging problem). */
        object BundleMissing : Result()

        /**
         * The CLI refused the install because the repo carries the `manuallyDisabled`
         * opt-out and the request asked it to respect that (`respectManualDisable`).
         *
         * NOT [Ok] and not [Failed]: nothing was written, so no success side effect may
         * fire — in particular no version stamp, since that would tell
         * [integrationsUpToDate] the current plugin version is fully enabled and
         * suppress every later integrations catch-up. Equally not a failure: refusing a
         * disabled repo is the designed outcome, so it must not raise an error balloon.
         *
         * Only reachable from an automatic path; every explicit user Enable sends
         * `respectManualDisable=false` precisely so the click can lift the opt-out.
         */
        object RefusedManuallyDisabled : Result()

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
        // Null like Ok: the repo is disabled on purpose, so there is nothing to warn
        // about. The caller decides what to do with the state; it is not an error.
        is Result.RefusedManuallyDisabled -> null
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
     *
     * Short-circuits when [EXTRACT_STAMP_FILE] already carries the current plugin version:
     * the file copy costs 50-300 ms of lock-guarded I/O, so skipping it when the dist is
     * byte-current is the single biggest saving on the Enable / Disable click path (both
     * flows call `enableFull` / `disableFull` → `runInstallViaBridge` → this method).
     * The stamp is written LAST inside the lock, after every `*.js` is copied, so any
     * reader observing the current fingerprint is guaranteed the files are complete
     * (no TOCTOU on partial writes).
     *
     * The short-circuit is additionally gated on [isDistComplete] — every bundled `*.js`
     * must still be present on disk, not just `Cli.js`. Write ordering only rules out a
     * copy that never finished; it says nothing about a file deleted AFTER the stamp
     * landed (an external cleanup, a Windows AV quarantine). Before this method cached
     * anything it re-copied unconditionally and therefore self-healed such a gap on the
     * next Enable click; a stamp-only check would instead skip forever at the same plugin
     * version, leaving a dist that `run-hook` cannot serve and that the CLI's
     * `isCompleteRuntimeDist` gate in [DistPathWriter.ts] refuses to register. Deriving
     * the expected set from the bundle keeps this honest with no hand-maintained mirror
     * of `REQUIRED_RUNTIME_FILES` to drift — the bundle is a superset of it — and costs
     * one `isFile` stat per entry (~µs) on the fast path.
     *
     * Fingerprint = plugin version + max mtime across every source `*.js`. Plugin
     * version alone is too coarse: during dev iteration (edit CLI → `npm run build`
     * → `gradle prepareSandbox`) the version string in `jollimemory-plugin-version.txt`
     * stays put, but every source `.js` gets a fresh mtime from the copy. Encoding
     * the max mtime makes any such rebuild — plus marketplace re-installs with the
     * same version, and a `touch` of any single file — invalidate the cache and
     * force a re-copy. `size` alone would miss pure whitespace/reformat changes,
     * and hashing every read is slow; a stat per file (~µs) on the fast path is the
     * cheap correct middle.
     *
     * Separate from the `.version` stamp: `.version` means "the last `jolli enable`
     * ran green for this version" and is cleared on disable, whereas the extract stamp
     * means "the on-disk files match the bundle we saw last" and survives disable —
     * so a subsequent enable click can still skip the copy.
     */
    fun extractCliDist(): File? {
        val cliJs = resolveBundledCliJs() ?: return null
        val srcDir = cliJs.parentFile ?: return null // the bundled cli-dist directory
        val distDir = distIntellijDir()
        val srcJs = listSourceJs(srcDir)
        val currentFingerprint = computeExtractFingerprint(srcJs)
        val extractStamp = File(distDir, EXTRACT_STAMP_FILE)
        // Fast path — no lock, no I/O beyond a listFiles/stat pass on the source, one
        // stat per expected dist entry, and one small stamp read. Reader-visible
        // ordering: the stamp is the LAST write inside the lock, so if it matches,
        // every `*.js` was fully written for this fingerprint — [isDistComplete] then
        // covers the case of one going missing afterwards.
        //
        // Wrapped in a defensive try: on Windows a concurrent writer's truncate/write
        // can trigger a sharing violation on `readText()`, which would otherwise bubble
        // out of `extractCliDist()` unhandled (the outer try below only guards the
        // copy branch). Fall through to the lock branch and let it serialize with the
        // in-flight writer instead.
        try {
            if (isDistComplete(distDir, srcJs) &&
                extractStamp.exists() &&
                extractStamp.readText(Charsets.UTF_8).trim() == currentFingerprint
            ) {
                return distDir
            }
        } catch (e: Exception) {
            log.info("Extract stamp fast-path read failed (falling through to lock): %s", e.message)
        }
        return try {
            distDir.mkdirs()
            // Copy the WHOLE dist (Cli.js + the per-hook entry scripts) so this dist also
            // satisfies `run-hook`, not just `run-cli`/MCP/skills.
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
                        // Re-check the fingerprint under the lock — the process we
                        // waited on may have just done the copy, so we can still skip.
                        // Re-list in case another writer just landed a fresher source.
                        val srcJsUnderLock = listSourceJs(srcDir)
                        val fpUnderLock = computeExtractFingerprint(srcJsUnderLock)
                        if (isDistComplete(distDir, srcJsUnderLock) &&
                            extractStamp.exists() &&
                            extractStamp.readText(Charsets.UTF_8).trim() == fpUnderLock
                        ) {
                            log.info("Bundled CLI dist already extracted for %s (skipped)", fpUnderLock)
                            return@use
                        }
                        val n = srcJsUnderLock
                            .onEach { it.copyTo(File(distDir, it.name), overwrite = true) }
                            .size
                        // Stamp AFTER every file lands so a reader can trust the stamp
                        // implies the files are complete.
                        extractStamp.writeText(fpUnderLock, Charsets.UTF_8)
                        log.info("Extracted bundled CLI dist (%d files) to %s (fp=%s)", n, distDir.absolutePath, fpUnderLock)
                    }
                }
            }
            distDir
        } catch (e: Exception) {
            log.error("Failed to extract bundled CLI: %s", e.message)
            null
        }
    }

    /**
     * The bundled entry scripts to extract: every `*.js` directly under the plugin's
     * `cli-dist/`. Both the cache key and the completeness check derive from this one
     * listing, so they can never disagree about which files the dist owes.
     */
    private fun listSourceJs(srcDir: File): List<File> =
        srcDir.listFiles { f: File -> f.isFile && f.name.endsWith(".js") }?.toList() ?: emptyList()

    /**
     * True when every bundled entry script from [listSourceJs] is present in [distDir].
     *
     * Guards the [extractCliDist] short-circuit: a stamp match alone would let a dist
     * that lost a per-hook entry script after extraction stay broken for the rest of
     * that plugin version. Empty source means "nothing known to be complete" → false,
     * so a bundle we failed to list falls through to the copy branch rather than
     * silently certifying an empty dist.
     */
    internal fun isDistComplete(distDir: File, srcJs: List<File>): Boolean =
        srcJs.isNotEmpty() && srcJs.all { File(distDir, it.name).isFile }

    /**
     * Computes the extract cache key: plugin version + max mtime across every source
     * `*.js`. A content change means a filesystem write on the bundle, which normally
     * bumps at least one mtime and so invalidates the extract cache without needing a
     * version bump. See [extractCliDist] for the design rationale.
     *
     * "Normally", not "always": on a volume with second-granularity mtimes, two
     * rebuilds inside the same second yield the same fingerprint and the second one is
     * skipped. That only reaches a developer running back-to-back builds — a
     * marketplace or release install always crosses a version or a second — and the
     * alternatives were weighed and rejected in [extractCliDist] (size misses
     * reformats; hashing every file costs a full read on the hot path). Delete the
     * stamp, or touch a source file, to force a re-copy.
     */
    private fun computeExtractFingerprint(srcJs: List<File>): String {
        val version = readPluginVersion()
        val maxMtime = srcJs.maxOfOrNull { it.lastModified() } ?: 0L
        return "$version|$maxMtime"
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
     * Sets up MCP + skills by calling the CLI's `install --integrations-only`
     * bridge action (tagged `intellij` so its dist-paths entry coexists with any
     * CLI/VS Code install). Returns [Result.NodeMissing] when Node is absent —
     * a clean skip, not an error.
     */
    fun enableIntegrations(projectDir: String): Result =
        runInstallViaBridge(
            projectDir,
            JsonObject().apply {
                addProperty("source", "cli")
                addProperty("sourceTag", "intellij")
                addProperty("integrationsOnly", true)
            },
            "integrations enable",
        )

    /**
     * FULL enable: routes to the CLI's `install` bridge action, which installs
     * EVERYTHING — the five git hooks (post-commit, post-rewrite,
     * prepare-commit-msg, post-merge, pre-push, all as Node `run-hook` dispatcher
     * scripts), the Claude Stop/SessionStart hooks, the Gemini AfterAgent hook,
     * skills, global instructions, MCP registration, and dispatch scripts.
     *
     * Historically ran as a fresh `node Cli.js enable --yes --source-tag intellij`
     * subprocess. Now travels the daemon fast path (with a one-shot spawn fallback
     * baked into [runIdeBridge]), which saves the ~300-600 ms Node cold-start +
     * Cli.js module-load per invocation. The `clearManualDisableOnSuccess=true`
     * flag mirrors what `EnableCommand.ts` sets when neither `--integrations-only`
     * nor `--automatic` is passed — namely, a successful enable clears any
     * `manuallyDisabled` opt-out so the repo isn't left in a mixed state.
     *
     * [respectManualDisable] makes the CLI refuse the whole install when the repo
     * carries that opt-out, turning `install` into a zero-write no-op
     * (`Installer.ts` → "Repository remains manually disabled"). Pass `true` from
     * AUTOMATIC paths only — an unattended startup repair has no business
     * resurrecting a repo the user turned off, and pairing it with
     * `clearManualDisableOnSuccess` is what makes the refusal necessary: without it
     * the install would go on to clear the on-disk flag, silently un-disabling the
     * repo. Leave it `false` (the default) for every EXPLICIT user action —
     * DisabledPanel's Enable, onboarding, the Settings re-enable — where the whole
     * point is to lift the opt-out; passing `true` there would make the button a
     * no-op that reports success.
     *
     * The two flags are MUTUALLY EXCLUSIVE, matching `EnableCommand.ts`
     * (`respectManualDisable: options.automatic` vs
     * `clearManualDisableOnSuccess: !integrationsOnly && !automatic`). Sending both
     * asks the CLI to honor the opt-out and then erase it — contradictory on its face,
     * and in the reachable case (a stale cache let an automatic install run against a
     * disabled repo) it also meant every such IDE start wrote `manuallyDisabled=false`
     * to a `profile.json` that the VFS watcher is watching, burning a debounce refresh
     * for nothing.
     */
    fun enableFull(projectDir: String, respectManualDisable: Boolean = false): Result =
        runInstallViaBridge(
            projectDir,
            JsonObject().apply {
                addProperty("source", "cli")
                addProperty("sourceTag", "intellij")
                if (respectManualDisable) {
                    addProperty("respectManualDisable", true)
                } else {
                    addProperty("clearManualDisableOnSuccess", true)
                }
            },
            "full enable",
        )

    /**
     * Shared install runner — pre-checks Node + bundle (so this can still return
     * the specific `NodeMissing` / `BundleMissing` results the UI branches on),
     * ships one request to the daemon-hosted `install` action, and maps the
     * returned [InstallResult] JSON envelope back to the Kotlin [Result] enum.
     * Version-stamps the dist dir on success so [integrationsUpToDate] sees the
     * successful enable — same lifecycle as the retired spawn path.
     *
     * Sets `distDir` on the request, and does it HERE rather than in the two callers so
     * neither can forget it. The CLI's `installDistPath` otherwise defaults to the
     * directory of the bundle executing the install, which under the retired
     * `ProcessBuilder(node, dist-intellij/Cli.js, "enable")` path was the right answer
     * by construction. It is not once the same code runs inside the daemon: that is
     * launched via [resolveCliJs], which prefers `<plugin>/cli-dist`, so
     * `dist-paths/intellij` would point into the IDE's version-scoped config directory
     * and go stale on a plugin uninstall or an IDE major upgrade. `run-hook` exits
     * silently by design (never block git), so the only symptom would be capture
     * quietly stopping. [extractCliDist] copies the bundle to the stable
     * `~/.jolli/…/dist-intellij` precisely so there is a location that survives both,
     * and this is what makes the registry agree with it — which also keeps
     * [markIntegrationsEnabled]'s `.version` stamp on the same dist that is registered.
     */
    private fun runInstallViaBridge(projectDir: String, request: JsonObject, label: String): Result {
        resolveNode() ?: return Result.NodeMissing
        val distDir = extractCliDist() ?: return Result.BundleMissing
        request.addProperty("distDir", distDir.absolutePath)
        return try {
            val json = runIdeBridge(
                projectDir,
                "install",
                gson.toJson(request),
                INSTALL_BRIDGE_TIMEOUT_SECONDS,
            ).asJsonObject
            // A `manuallyDisabled` success is a ZERO-WRITE refusal, not an install —
            // checked BEFORE the success arm because it arrives as `success: true`.
            // Treating it as Ok stamped the version (making integrationsUpToDate
            // permanently true for this plugin version, so the upgrade catch-up branch
            // never ran again) and told the caller the install landed, which left the
            // optimistically-cleared manuallyDisabled cache un-rolled-back.
            if (json.get("manuallyDisabled")?.asBoolean == true) {
                log.info("Bundled CLI %s refused: repository is manually disabled (nothing written)", label)
                Result.RefusedManuallyDisabled
            } else if (json.get("success")?.asBoolean == true) {
                // Stamp "enabled" ONLY now — after a confirmed success — so a later
                // failure or an interrupted run is never mistaken for a completed
                // one. A full enable is a superset of the integrations-only enable,
                // so it stamps too. Atomic-move implementation keeps concurrent
                // readers (CliDaemonClient.currentDistVersion on every daemon call)
                // from ever seeing a half-truncated stamp.
                markIntegrationsEnabled(distDir)
                log.info("Bundled CLI %s succeeded (bridge)", label)
                Result.Ok
            } else {
                clearIntegrationsEnabled(distDir)
                val message = json.get("message")?.asString ?: "$label failed"
                log.warn("Bundled CLI %s failed (bridge): %s", label, message.take(500))
                Result.Failed(message)
            }
        } catch (e: CliBridgeException) {
            clearIntegrationsEnabled(distDir)
            log.error("Failed to run bundled CLI %s (bridge): %s", label, e.message)
            Result.Failed(e.message ?: "bridge error")
        } catch (e: Exception) {
            clearIntegrationsEnabled(distDir)
            log.error("Failed to run bundled CLI %s (bridge): %s", label, e.message)
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

        val outFile = createSecureTempFile("jolli-generate-", ".json")
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
        val daemon = findDaemonForCwd(projectDir)
        if (daemon != null) {
            try {
                return daemon.call(action, projectDir, requestJson, timeoutSeconds)
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
        }
        // No daemon (or the daemon call failed): fall through to a one-shot Node spawn.
        val node = resolveNode()
            ?: throw RuntimeException("Node.js not found — it is required for Jolli Memory. Install Node.js and reopen the project.")
        val cliJs = resolveCliJs()
            ?: throw RuntimeException("The bundled CLI was not found in the plugin. Try reinstalling Jolli Memory.")
        val outFile = createSecureTempFile("jolli-ide-bridge-", ".json")
        try {
            val pb = ProcessBuilder(node, cliJs.absolutePath, "ide-bridge", action, "--cwd", projectDir)
                .directory(File(projectDir))
                .redirectOutput(outFile)
                .redirectError(ProcessBuilder.Redirect.DISCARD)
            // Forward the ambient Kotlin trace id (when inside a withTrace scope)
            // so Cli.ts's `runWithTrace(traceIdFromEnv(), ...)` adopts it — that
            // keeps the CLI's outbound HTTP calls sharing the IDE-scoped trace id
            // (`x-jolli-trace`) instead of minting a fresh CLI-only one, so the
            // IDE / CLI / backend logs remain grep-able by one id.
            val traceId = TraceContext.getCurrentTraceId()
            if (!traceId.isNullOrBlank()) {
                pb.environment()["JOLLI_TRACE_ID"] = traceId
            }
            val proc = pb.start()
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

    /** One per-worktree/per-integration failure from the [syncAgentHooks] bridge action. */
    data class HookSyncFailure(
        val worktree: String,
        val integration: String,
        val message: String,
    )

    /**
     * Result of one `sync-agent-hooks` bridge call. `manuallyDisabled` mirrors
     * VS Code's [SettingsWebviewPanel.syncHooks] early-return: the CLI-side
     * handler refuses to install/remove hooks while [`profile.json`'s
     * `manuallyDisabled` flag][ai.jolli.jollimemory.core.RepoProfile] is set, so
     * the Settings dialog stays reachable during a manual disable without
     * silently reinstating hooks.
     */
    data class SyncAgentHooksResult(
        val manuallyDisabled: Boolean,
        val worktrees: List<String>,
        val failures: List<HookSyncFailure>,
    )

    /**
     * Installs or removes the Claude Stop and Gemini AfterAgent hooks for every
     * worktree of the given repo, matching the current per-agent toggles.
     * Replaces the previous every-Settings-save `jolli enable --integrations-only`
     * subprocess (500 ms – 2 s cold Node spawn) with a daemon RPC (~5-20 ms) and
     * — for the first time on IntelliJ — brings **all** worktrees into sync on
     * one Apply, matching VS Code's [`SettingsWebviewPanel.syncHooks`].
     *
     * The CLI-side handler reuses the exact same hook helpers VS Code calls
     * in-process (`installClaudeHook` / `removeClaudeHook` / `installGeminiHook` /
     * `removeGeminiHook`, exported from `cli/src/install/Installer.ts`), so the
     * two surfaces cannot drift on hook wire format. Idempotent — re-running
     * with the same flags rewrites the same JSON block, so callers can invoke
     * it on every Apply without gating.
     *
     * Business errors propagate as [CliBridgeException] (same shape as every
     * other bridge action). Per-worktree per-integration failures land in
     * `failures[]` without aborting the loop, so a single bad worktree does not
     * stop the rest from syncing.
     */
    fun syncAgentHooks(
        projectDir: String,
        claudeEnabled: Boolean,
        geminiEnabled: Boolean,
    ): SyncAgentHooksResult {
        val body = com.google.gson.JsonObject().apply {
            addProperty("claudeEnabled", claudeEnabled)
            addProperty("geminiEnabled", geminiEnabled)
        }.toString()
        val result = parseSyncAgentHooksResponse(runIdeBridge(projectDir, "sync-agent-hooks", body))
        log.info(
            "sync-agent-hooks succeeded (manuallyDisabled=%s, worktrees=%d, failures=%d)",
            result.manuallyDisabled,
            result.worktrees.size,
            result.failures.size,
        )
        return result
    }

    /**
     * Parses the `sync-agent-hooks` action's JSON envelope. Split out for direct
     * testing — the CLI-side handler carries the reference shape (see
     * [`runIdeBridgeAction`][ai.jolli.jollimemory.bridge] case `"sync-agent-hooks"`
     * in `cli/src/commands/IdeBridgeCommand.ts`) and this parser MUST tolerate
     * every documented one: `manuallyDisabled=true` short-circuit,
     * empty-worktrees / empty-failures, and a mixed `failures[]` of well-formed
     * entries with the ordinary `{worktree,integration,message}` shape.
     *
     * All three documented fields (`manuallyDisabled`, `worktrees`, `failures`)
     * are validated fail-loud: missing or wrong-typed → [RuntimeException]. The
     * CLI-side handler writes every field on every return (see the
     * `sync-agent-hooks` case in `cli/src/commands/IdeBridgeCommand.ts`), so an
     * absent field signals wire drift, not a legitimate response, and silent-
     * defaulting would hide it — a missing `manuallyDisabled` collapsed to
     * `false` makes the caller SKIP the manual-disable balloon (an
     * over-suppress the user cannot see); a missing `worktrees` collapsed to
     * `[]` hides real per-worktree failures behind "everything looks fine".
     */
    internal fun parseSyncAgentHooksResponse(result: com.google.gson.JsonElement): SyncAgentHooksResult {
        val obj = result.takeIf { it.isJsonObject }?.asJsonObject
            ?: throw RuntimeException("sync-agent-hooks returned unreadable response: $result")
        val manuallyDisabledEl = obj.get("manuallyDisabled")
            ?: throw RuntimeException(
                "sync-agent-hooks returned unreadable response: missing 'manuallyDisabled' field: $result",
            )
        if (!manuallyDisabledEl.isJsonPrimitive || !manuallyDisabledEl.asJsonPrimitive.isBoolean) {
            throw RuntimeException(
                "sync-agent-hooks returned unreadable response: 'manuallyDisabled' is not a boolean: $result",
            )
        }
        val manuallyDisabled = manuallyDisabledEl.asBoolean
        val worktreesEl = obj.get("worktrees")
            ?: throw RuntimeException("sync-agent-hooks returned unreadable response: missing 'worktrees' field: $result")
        if (!worktreesEl.isJsonArray) {
            throw RuntimeException("sync-agent-hooks returned unreadable response: 'worktrees' is not an array: $result")
        }
        val worktrees = worktreesEl.asJsonArray
            .mapNotNull { it.takeIf { el -> el.isJsonPrimitive && el.asJsonPrimitive.isString }?.asString }
        val failuresEl = obj.get("failures")
            ?: throw RuntimeException("sync-agent-hooks returned unreadable response: missing 'failures' field: $result")
        if (!failuresEl.isJsonArray) {
            throw RuntimeException("sync-agent-hooks returned unreadable response: 'failures' is not an array: $result")
        }
        val failures = failuresEl.asJsonArray.mapNotNull { el ->
            val entry = el.takeIf { it.isJsonObject }?.asJsonObject ?: return@mapNotNull null
            HookSyncFailure(
                worktree = entry.get("worktree")?.asString.orEmpty(),
                integration = entry.get("integration")?.asString.orEmpty(),
                message = entry.get("message")?.asString.orEmpty(),
            )
        }
        return SyncAgentHooksResult(manuallyDisabled, worktrees, failures)
    }

    /** Result of one `ide-bridge migrate-memory-bank` action call — the subset the UI status lines need. */
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
     * `runMemoryBankMigration` (see cli/src/core/MemoryBankMigration.ts),
     * delivered over the standard ide-bridge transport. The CLI is the sole
     * migration implementation: it resolves the Memory Bank root from the shared
     * config, runs the full migration when it has not completed yet, and otherwise
     * runs the idempotent stale-child reconcile — matching the VS Code activate
     * path.
     *
     * Transport: [runIdeBridge] prefers the long-lived daemon (~5-20 ms startup
     * vs a dedicated cold Node spawn's ~500 ms-2 s) and falls back to a one-shot
     * `ide-bridge` spawn when no daemon is bound — the pre-daemon startup path
     * still works. The daemon dispatches requests concurrently, so a long
     * migration cannot block hot-path actions (status, config reads).
     *
     * Timeout semantics: [MIGRATE_TIMEOUT_SECONDS] is passed through. On a daemon
     * timeout the daemon KEEPS running the migration — a one-shot fallback would
     * start the same side-effectful work twice, so the timeout surfaces as
     * [CliDaemonClient.CliDaemonTimeoutException] and the next (idempotent) kick
     * picks up whatever state the run reached.
     *
     * Business errors propagate as [CliBridgeException] (same shape as every
     * other bridge action); callers surface `ex.message`.
     */
    fun migrateMemoryBank(projectDir: String): MigrationBridgeResult {
        val result = parseMigrateResponse(runIdeBridge(projectDir, "migrate-memory-bank", null, MIGRATE_TIMEOUT_SECONDS))
        log.info("migrate-memory-bank succeeded: %s (%d/%d)", result.status, result.migratedEntries, result.totalEntries)
        return result
    }

    /**
     * Parses the `migrate-memory-bank` action's JSON envelope. Split out for
     * direct testing — the CLI-side reference shape lives in
     * `cli/src/core/MemoryBankMigration.ts` (`{status, totalEntries,
     * migratedEntries}`), and the parser tolerates the extra state keys the
     * MigrationEngine may add (they are ignored). A non-object envelope
     * (e.g. an empty response after a daemon timeout that still returned) is
     * a hard error — the caller cannot proceed without a status.
     */
    internal fun parseMigrateResponse(result: com.google.gson.JsonElement): MigrationBridgeResult {
        val obj = result.takeIf { it.isJsonObject }?.asJsonObject
            ?: throw RuntimeException("Memory Bank migration returned unreadable response: $result")
        val status = obj.get("status")?.asString ?: "unknown"
        val migrated = obj.get("migratedEntries")?.asInt ?: 0
        val total = obj.get("totalEntries")?.asInt ?: 0
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
     * Tears down the MCP registration via the CLI's `uninstall` bridge action
     * with `integrationsOnly=true` (best-effort). No-op when Node or the bundle
     * is missing — nothing to undo that we could reach. Mirrors the shape
     * `DisableCommand.ts` builds when passed `--integrations-only`:
     * `preserveMenu=false`, `persistManualDisable=false` (neither is a full disable).
     */
    fun disableIntegrations(projectDir: String): Result =
        runUninstallViaBridge(
            projectDir,
            JsonObject().apply {
                addProperty("integrationsOnly", true)
            },
            "integrations disable",
        )

    /**
     * FULL disable: routes to the CLI's `uninstall` bridge action, which removes
     * the git hook sections (same markers regardless of which surface wrote them,
     * including legacy `java -jar` bodies), the Claude and Gemini agent hooks,
     * and the repo-scoped MCP registration. Global MCP entries stay, per the
     * CLI's conservative uninstall policy.
     *
     * `preserveMenu=true` + `persistManualDisable=true` mirror what
     * `DisableCommand.ts` sets from a plain `jolli disable` (no
     * `--integrations-only`), so the daemon path is byte-equivalent to the
     * spawn command line we retired.
     */
    fun disableFull(projectDir: String): Result =
        runUninstallViaBridge(
            projectDir,
            JsonObject().apply {
                addProperty("preserveMenu", true)
                addProperty("persistManualDisable", true)
            },
            "full disable",
        )

    /**
     * Shared uninstall runner — same daemon-fast-path + spawn-fallback machinery
     * as [runInstallViaBridge], but never touches the version stamp (a disable
     * doesn't invalidate the last-successful-enable record; the next install
     * will re-stamp cleanly if it succeeds, or the stale stamp keeps signalling
     * "installed for version X" which is honest).
     */
    private fun runUninstallViaBridge(projectDir: String, request: JsonObject, label: String): Result {
        resolveNode() ?: return Result.NodeMissing
        extractCliDist() ?: return Result.BundleMissing
        return try {
            val json = runIdeBridge(
                projectDir,
                "uninstall",
                gson.toJson(request),
                INSTALL_BRIDGE_TIMEOUT_SECONDS,
            ).asJsonObject
            if (json.get("success")?.asBoolean == true) {
                log.info("Bundled CLI %s succeeded (bridge)", label)
                Result.Ok
            } else {
                val message = json.get("message")?.asString ?: "$label failed"
                log.warn("Bundled CLI %s failed (bridge): %s", label, message.take(500))
                Result.Failed(message)
            }
        } catch (e: CliBridgeException) {
            log.warn("Failed to run bundled CLI %s (bridge, non-fatal): %s", label, e.message)
            Result.Failed(e.message ?: "bridge error")
        } catch (e: Exception) {
            log.warn("Failed to run bundled CLI %s (bridge, non-fatal): %s", label, e.message)
            Result.Failed(e.message ?: "unknown")
        }
    }

    class CliBridgeException(
        val errorName: String?,
        message: String,
        val details: com.google.gson.JsonObject = com.google.gson.JsonObject(),
    ) : RuntimeException(message)
}
