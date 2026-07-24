package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.HookEnv
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.io.File
import java.util.concurrent.TimeUnit

/** A verified Node.js runtime: absolute binary path + `node --version` output (e.g. "v22.14.0"). */
data class NodeInfo(val path: String, val version: String)

/**
 * A Node install found during detection but rejected as unusable.
 *
 * Currently the only rejection reason is "runs, but version below [NodeRuntime.MIN_SUPPORTED_MAJOR]".
 * Surfaced so the UI can tell the user "we saw v14.21.3 at /opt/homebrew/bin/node — please upgrade"
 * instead of a bare "no Node found", which is confusing on a machine that clearly has Node.
 */
data class RejectedCandidate(val path: String, val version: String)

/**
 * NodeRuntime — locates and verifies a usable Node.js runtime, and records the result.
 *
 * Why not simply spawn `node --version` and see if it works: subprocesses inherit the
 * IDE process environment, and a GUI-launched IDE (Dock / Launchpad / desktop shortcut)
 * gets a minimal PATH (`/usr/bin:/bin:...`) that lacks nvm/homebrew/volta locations. A
 * naive spawn therefore reports "missing" on machines that DO have Node. Conversely,
 * merely finding an executable file on some PATH is not proof it runs. Detection is
 * therefore two-phase: gather candidate binaries from every plausible channel, then
 * verify candidates by actually executing `<candidate> --version` — the first binary
 * that answers wins.
 *
 * Candidate channels, in order:
 *  1. The binary recorded in `~/.jolli/jollimemory/node-info.json` by a previous
 *     successful detection (fast path — skips the shell probes entirely).
 *  2. The IDE process PATH (correct when the IDE was launched from a terminal; free).
 *  3. The LOGIN shell PATH (`$SHELL -lc`) — loads ~/.zprofile, where homebrew lives.
 *  4. The INTERACTIVE login shell PATH (`$SHELL -lic`) — additionally loads ~/.zshrc,
 *     which is where nvm's init line is installed by default.
 *  5. On Windows: the official MSI installer's registry record
 *     (`HKLM/HKCU\SOFTWARE\Node.js InstallPath`) — unlike the process PATH (a snapshot
 *     taken at IDE launch), the registry reflects an install done AFTER the IDE
 *     started, which is exactly the Retry-button scenario.
 *  6. Well-known install locations (homebrew, MacPorts, nvm, nvm.fish, volta, fnm,
 *     asdf, mise, nodenv, n; on Windows: Program Files, scoop, chocolatey,
 *     nvm-windows, Volta).
 *
 * Verification also enforces [MIN_SUPPORTED_MAJOR]: the plugin's bundled Cli.js
 * cannot run on ancient Node, so a v12 on PATH must count as "not usable", not as a
 * successful detection — a newer install elsewhere can still win via later channels.
 *
 * Shell probes wrap `$PATH` in sentinel markers so rc-file noise (echoes, warnings,
 * prompts) cannot corrupt the extracted value, use fish-specific syntax when `$SHELL`
 * is fish (fish has no `${}` expansion and PATH is a list, not a colon string), and
 * enforce a hard timeout with the wait-then-read order so a hanging rc file (tmux
 * auto-attach etc.) cannot block.
 *
 * The verified result is persisted to `~/.jolli/jollimemory/node-info.json`
 * (`{path, version, source, detectedAt}`) and cached in-process. Every write also
 * records the bare absolute path in a plain-text sibling `node-path` (one line),
 * kept in lockstep with the JSON record: the shell hook dispatchers (run-hook /
 * run-cli) read it as a node fallback when the git process PATH has none (GUI git
 * clients launch git with a minimal PATH), and parsing JSON in POSIX sh is fragile
 * (Windows path escaping). [detect] with `forceRefresh = true` re-runs the full
 * probe — used by the tool window's Retry button after the user installs Node.
 * When every automatic channel fails, the blocking panel offers a file chooser;
 * the pick goes through [adoptManualSelection], which applies the exact same
 * `--version` + minimum-version proof before adopting.
 *
 * When detection returns null, callers can read [rejectedFromLastDetection] to explain
 * WHY — currently: Node installs that ran but were below [MIN_SUPPORTED_MAJOR] — so the
 * UI can be specific ("v14.21.3 at /opt/homebrew/bin/node — too old") instead of a
 * generic "no Node found" that reads as a bug on machines that clearly have Node.
 *
 * Thread-safety: [detect] is synchronized (concurrent callers share one probe) and
 * blocking (shell probes can take seconds on first run) — call it off the EDT.
 * [cached] never blocks and is safe anywhere.
 */
object NodeRuntime {

    private val log = JmLogger.create("NodeRuntime")

    /**
     * Access point for every JVM-global read this file needs (osName, userHome, getenv).
     * Defaults to the real process globals; tests inject a fake via [setEnvForTest] so
     * detection can be exercised deterministically. Routing everything through this one
     * field is what keeps the file out of scripts/main-globals-baseline.txt — the
     * checkGlobalState gate greps for direct process-global reads (env vars, system
     * properties, standard streams).
     */
    @Volatile
    private var env: HookEnv = HookEnv()

    /** Test seam: swap in a fake HookEnv (see TestEnvs.fakeHookEnv). */
    internal fun setEnvForTest(newEnv: HookEnv) = synchronized(detectLock) {
        env = newEnv
    }

    private val isWindows: Boolean
        get() = env.osName.lowercase().contains("win")

    internal const val INFO_FILE_NAME = "node-info.json"

    /**
     * Plain-text sibling of [INFO_FILE_NAME] holding ONLY the absolute binary path
     * (one line). The shell hook dispatchers (run-hook / run-cli) read it as their
     * node fallback when the git process PATH has none — GUI git clients launch git
     * with a minimal PATH, so without this record their hooks would silently no-op
     * on a machine that clearly has Node. Plain text (not the JSON record) because
     * POSIX sh has no robust JSON parsing — Windows paths arrive backslash-escaped
     * in JSON strings, which sed/grep mangling gets wrong. Written and deleted in
     * lockstep with [INFO_FILE_NAME] so the two can never disagree.
     */
    internal const val PATH_FILE_NAME = "node-path"

    /**
     * Oldest Node major the bundled Cli.js runs on (the esbuild bundle targets Node 18;
     * `node:sqlite`-dependent features degrade gracefully above that). Older binaries
     * are rejected during verification so "detected" always means "actually usable".
     */
    internal const val MIN_SUPPORTED_MAJOR = 18

    private const val PATH_MARK_START = "__JOLLI_PATH_START__"
    private const val PATH_MARK_END = "__JOLLI_PATH_END__"
    private const val SHELL_PROBE_TIMEOUT_SECONDS = 5L
    private const val VERSION_PROBE_TIMEOUT_SECONDS = 10L
    private const val REG_QUERY_TIMEOUT_SECONDS = 5L

    private val detectLock = Any()

    @Volatile
    private var cachedInfo: NodeInfo? = null

    @Volatile
    private var detectionDone = false

    @Volatile
    private var rejectedList: List<RejectedCandidate> = emptyList()

    /**
     * Non-blocking: the last detection outcome. `null` means "not found" OR "not yet
     * detected" — distinguish with [hasDetected] when it matters for UI wording.
     */
    fun cached(): NodeInfo? = cachedInfo

    /** Non-blocking: true once a detection pass has completed in this process (found or not). */
    fun hasDetected(): Boolean = detectionDone

    /**
     * Non-blocking: candidates that ran during the last [detect] pass but were rejected
     * (currently: Node installs below [MIN_SUPPORTED_MAJOR]). Empty when detection has
     * never run, when detection succeeded via the fast path or on the first candidate,
     * or when no candidate answered `--version` at all. Read by UI code to explain why
     * automatic detection failed on a machine that clearly has Node.
     */
    fun rejectedFromLastDetection(): List<RejectedCandidate> = rejectedList

    /**
     * Finds a verified Node runtime, or `null` when none exists. Blocking — first run
     * may spawn shell probes (seconds); later runs return the in-process cache. A
     * negative outcome is also cached for the process lifetime so gate checks stay
     * cheap; pass [forceRefresh] to probe again (Retry button, post-install).
     */
    fun detect(forceRefresh: Boolean = false): NodeInfo? = synchronized(detectLock) {
        if (!forceRefresh && detectionDone) return cachedInfo

        // Reset the rejected list for THIS pass so callers never see stale data from a
        // previous probe. Fast-path success leaves it empty (nothing to report when we
        // never scanned the full set); the full-probe branch below fills it if any
        // candidate answered --version but was too old.
        rejectedList = emptyList()

        // Fast path: re-verify the binary recorded by a previous successful detection.
        // Skipped on forceRefresh so Retry always re-runs the full probe. When the
        // version has drifted (e.g. a patch upgrade under a manually-picked binary),
        // we rewrite the record but preserve the original source tag so a "manual"
        // pick is never silently reclassified as "auto".
        if (!forceRefresh) {
            readRecord(infoFile())?.let { recorded ->
                val fresh = verify(recorded.info.path)
                if (fresh is VerifyResult.Ok) {
                    if (fresh.info != recorded.info) {
                        writeRecordedInfo(infoFile(), fresh.info, source = recorded.source)
                    }
                    return finish(fresh.info)
                }
            }
        }

        // Full probe: walk every candidate. Stop at the first Ok; collect TooOld hits
        // (deduped by path — a version manager plus PATH shim can list the same binary
        // twice) so the UI can name the rejected version, not just say "not found".
        val rejected = LinkedHashMap<String, RejectedCandidate>()
        var found: NodeInfo? = null
        for (candidate in candidateBinaries()) {
            when (val result = verify(candidate)) {
                is VerifyResult.Ok -> {
                    found = result.info
                    break
                }
                is VerifyResult.TooOld ->
                    rejected.putIfAbsent(result.path, RejectedCandidate(result.path, result.version))
                VerifyResult.NotUsable -> {} // silently skip: not a runnable Node
            }
        }
        rejectedList = rejected.values.toList()

        if (found != null) {
            log.info("Node runtime verified: %s (%s)", found.path, found.version)
            writeRecordedInfo(infoFile(), found)
        } else {
            log.warn("No usable Node runtime found (probed process/login/interactive PATH + well-known dirs)")
            // Drop stale records so the fast path (and the shell hook dispatchers'
            // node-path fallback) can't resurrect a binary that just failed.
            try {
                infoFile().delete()
            } catch (_: Exception) {
                // best-effort cleanup
            }
            deletePathFile(infoFile())
        }
        finish(found)
    }

    private fun finish(info: NodeInfo?): NodeInfo? {
        cachedInfo = info
        detectionDone = true
        return info
    }

    // ── Manual selection (file-chooser fallback) ────────────────────────────

    /** Outcome of validating a user-picked binary, with enough detail for UI wording. */
    sealed class ManualSelectionResult {
        /** The pick is a usable Node runtime and is now the recorded one. */
        data class Accepted(val info: NodeInfo) : ManualSelectionResult()

        /** The pick runs, but its version is below [MIN_SUPPORTED_MAJOR]. */
        data class TooOld(val version: String) : ManualSelectionResult()

        /** The pick exists but `--version` failed or printed no Node version. */
        object NotNode : ManualSelectionResult()

        /** The pick is not a regular executable file. */
        object NotExecutable : ManualSelectionResult()
    }

    /** File names the manual chooser accepts as a Node binary (chooser-side filter). */
    fun isNodeExecutableName(fileName: String): Boolean {
        val n = fileName.lowercase()
        return n == "node" || n == "node.exe" || n == "node.cmd"
    }

    /**
     * Validates a binary the user picked in the file chooser and — when it proves to be
     * a usable Node runtime — adopts it: records it in node-info.json (tagged
     * `source: "manual"`) and makes it the in-process detection result. The same
     * `--version` + minimum-version proof as automatic detection applies, so picking a
     * wrong file can never unblock the plugin. Blocking — call off the EDT.
     */
    fun adoptManualSelection(binPath: String): ManualSelectionResult =
        adoptManualSelection(binPath, infoFile())

    /** Testable seam: same validation/adoption against an explicit record file. */
    internal fun adoptManualSelection(binPath: String, recordFile: File): ManualSelectionResult =
        synchronized(detectLock) {
            val f = File(binPath)
            if (!f.isFile || !f.canExecute()) return ManualSelectionResult.NotExecutable
            val version = probeVersion(f) ?: return ManualSelectionResult.NotNode
            val major = versionMajor(version)
            if (major == null || major < MIN_SUPPORTED_MAJOR) return ManualSelectionResult.TooOld(version)
            val info = NodeInfo(f.absolutePath, version)
            writeRecordedInfo(recordFile, info, source = "manual")
            log.info("Node runtime adopted from manual selection: %s (%s)", info.path, info.version)
            // Clear any TooOld candidates left over from the prior detect() pass: the
            // manually-picked binary is now the authoritative outcome, so
            // rejectedFromLastDetection() must not keep returning stale rejections.
            rejectedList = emptyList()
            finish(info)
            ManualSelectionResult.Accepted(info)
        }

    /** Test-only: clears the in-process detection state (NodeRuntime is a singleton). */
    internal fun resetForTest() = synchronized(detectLock) {
        cachedInfo = null
        detectionDone = false
        rejectedList = emptyList()
        env = HookEnv()
    }

    // ── Candidate discovery ─────────────────────────────────────────────────

    /** Ordered, de-duplicated candidate binaries that exist and are executable. */
    private fun candidateBinaries(): List<String> {
        val names = if (isWindows) listOf("node.exe", "node.cmd", "node") else listOf("node")
        val dirs = LinkedHashSet<String>()
        splitPath(env.getenv("PATH")).forEach { dirs.add(it) }
        if (!isWindows) {
            splitPath(shellPath(interactive = false)).forEach { dirs.add(it) }
            splitPath(shellPath(interactive = true)).forEach { dirs.add(it) }
        }
        val candidates = LinkedHashSet<String>()
        for (dir in dirs) {
            for (name in names) {
                val f = File(dir, name)
                if (f.isFile && f.canExecute()) candidates.add(f.absolutePath)
            }
        }
        wellKnownBinaries().forEach { candidates.add(it) }
        return candidates.toList()
    }

    private fun splitPath(path: String?): List<String> =
        path?.split(File.pathSeparator)?.filter { it.isNotBlank() } ?: emptyList()

    /**
     * The user's shell, or a fallback that actually exists on this OS. macOS always
     * ships /bin/zsh, but many Linux distros ship only bash or sh — a hardcoded zsh
     * fallback would silently disable both shell probes there.
     */
    private fun resolveShell(): String? {
        env.getenv("SHELL")?.takeIf { it.isNotBlank() && File(it).canExecute() }?.let { return it }
        return listOf("/bin/zsh", "/bin/bash", "/bin/sh").firstOrNull { File(it).canExecute() }
    }

    /**
     * `$PATH` as reported by the user's shell. [interactive] adds `-i` so rc files
     * (~/.zshrc — nvm's default home) are loaded too. Wait-then-read order: if the
     * shell hangs it is force-killed at the timeout and we read whatever it buffered,
     * so a pathological rc file can never wedge detection. csh/tcsh reject the flag
     * combination and print no marker — that degrades to null and the well-known
     * directory fallback covers those users.
     */
    private fun shellPath(interactive: Boolean): String? {
        return try {
            val shell = resolveShell() ?: return null
            val flags = if (interactive) "-lic" else "-lc"
            // POSIX shells: braced ${PATH}, because the end marker starts with an
            // underscore and an unbraced $PATH would be greedily parsed as one long
            // variable name. fish: no ${} syntax at all, and $PATH is a list — the
            // marker quotes concatenate with the command substitution's output.
            val echoCommand = if (File(shell).name == "fish") {
                "echo \"$PATH_MARK_START\"(string join : \$PATH)\"$PATH_MARK_END\""
            } else {
                "echo \"$PATH_MARK_START\${PATH}$PATH_MARK_END\""
            }
            val proc = ProcessBuilder(shell, flags, echoCommand)
                .redirectErrorStream(true)
                .start()
            proc.outputStream.close() // EOF on stdin so an interactive shell can't wait for input
            if (!proc.waitFor(SHELL_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                proc.waitFor(1, TimeUnit.SECONDS)
            }
            extractMarkedPath(proc.inputStream.bufferedReader().use { it.readText() })
        } catch (_: Exception) {
            null
        }
    }

    /** Pulls the marker-wrapped PATH out of shell output that may contain rc-file noise. */
    internal fun extractMarkedPath(output: String): String? {
        val start = output.lastIndexOf(PATH_MARK_START)
        if (start < 0) return null
        val from = start + PATH_MARK_START.length
        val end = output.indexOf(PATH_MARK_END, from)
        if (end < 0) return null
        return output.substring(from, end).trim().takeIf { it.isNotBlank() }
    }

    /** Install locations of the common Node distribution channels, newest version first. */
    private fun wellKnownBinaries(): List<String> {
        if (isWindows) return windowsWellKnownBinaries()
        val home = env.userHome.path
        val fixed = listOf(
            "/opt/homebrew/bin/node", // homebrew (Apple Silicon)
            "/usr/local/bin/node", // homebrew (Intel) / nodejs.org pkg installer / tj-n default
            "/opt/local/bin/node", // MacPorts
            "/usr/bin/node", // Linux distro package
            "$home/.volta/bin/node",
            "$home/.asdf/shims/node",
            "$home/.nodenv/shims/node",
            "$home/.n/bin/node", // tj/n with N_PREFIX=~/.n
            "$home/.local/share/mise/shims/node",
        ).filter { File(it).isFile }
        val posixRel = listOf("bin/node", "installation/bin/node")
        val versioned = listOf(
            "$home/.nvm/versions/node", // nvm: <root>/vX.Y.Z/bin/node
            "$home/.local/share/nvm", // nvm.fish: <root>/vX.Y.Z/bin/node
            "$home/.fnm/node-versions", // fnm: <root>/vX.Y.Z/installation/bin/node
            "$home/.local/share/fnm/node-versions",
            "$home/Library/Application Support/fnm/node-versions",
            "$home/.local/share/mise/installs/node", // mise: <root>/X.Y.Z/bin/node
        ).flatMap { versionedBinaries(it, posixRel) }
        return fixed + versioned
    }

    /**
     * Windows install channels. The registry record comes FIRST: the process PATH is a
     * snapshot from IDE launch, so an official-MSI install done while the IDE is open
     * (the Retry-button scenario) is invisible to PATH but present in the registry.
     */
    private fun windowsWellKnownBinaries(): List<String> {
        val out = LinkedHashSet<String>()
        registryNodeInstallPath()?.let { out.add(File(it, "node.exe").absolutePath) }
        env.getenv("ProgramFiles")?.let { out.add("$it\\nodejs\\node.exe") }
        env.getenv("ProgramFiles(x86)")?.let { out.add("$it\\nodejs\\node.exe") }
        env.getenv("LOCALAPPDATA")?.let { out.add("$it\\Programs\\nodejs\\node.exe") }
        val userProfile = env.getenv("USERPROFILE") ?: env.userHome.path
        out.add("$userProfile\\scoop\\shims\\node.exe") // scoop
        env.getenv("ProgramData")?.let { out.add("$it\\chocolatey\\bin\\node.exe") } // chocolatey shim
        env.getenv("LOCALAPPDATA")?.let { out.add("$it\\Volta\\bin\\node.exe") } // Volta (Windows default)
        out.add("$userProfile\\.volta\\bin\\node.exe")
        // nvm-windows: NVM_HOME is set machine-wide by its installer; layout is
        // <root>\vX.Y.Z\node.exe (no bin\ segment).
        val nvmHome = env.getenv("NVM_HOME") ?: env.getenv("APPDATA")?.let { "$it\\nvm" }
        val versioned = if (nvmHome != null) versionedBinaries(nvmHome, listOf("node.exe")) else emptyList()
        return out.filter { File(it).isFile } + versioned
    }

    /**
     * `InstallPath` from `HKLM/HKCU\SOFTWARE\Node.js` — written by the official
     * Windows MSI installer. Queried via `reg.exe` (no JNI), best-effort.
     */
    private fun registryNodeInstallPath(): String? {
        for (hive in listOf("HKLM", "HKCU")) {
            try {
                val proc = ProcessBuilder("reg", "query", "$hive\\SOFTWARE\\Node.js", "/v", "InstallPath")
                    .redirectErrorStream(true)
                    .start()
                proc.outputStream.close()
                if (!proc.waitFor(REG_QUERY_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                    proc.destroyForcibly()
                    proc.waitFor(1, TimeUnit.SECONDS)
                    continue
                }
                if (proc.exitValue() != 0) continue
                val out = proc.inputStream.bufferedReader().use { it.readText() }
                val path = parseRegInstallPath(out)
                if (path != null) return path
            } catch (_: Exception) {
                // reg.exe unavailable or query failed — fall through to the next hive
            }
        }
        return null
    }

    /** Pulls the InstallPath value out of `reg query` output. */
    internal fun parseRegInstallPath(output: String): String? =
        Regex("InstallPath\\s+REG_(?:EXPAND_)?SZ\\s+(.+)").find(output)
            ?.groupValues?.get(1)?.trim()?.takeIf { it.isNotBlank() }

    /** Binaries under a version-manager root (one dir per version), newest first. */
    private fun versionedBinaries(root: String, relativePaths: List<String>): List<String> {
        val dir = File(root)
        if (!dir.isDirectory) return emptyList()
        return (dir.listFiles { f -> f.isDirectory } ?: emptyArray())
            .sortedByDescending { versionSortKey(it.name) }
            .mapNotNull { versionDir ->
                relativePaths.map { File(versionDir, it) }.firstOrNull { it.isFile }?.absolutePath
            }
    }

    /** Numeric sort key for "v22.14.0"-style directory names; unparseable names sort last. */
    internal fun versionSortKey(name: String): Long {
        val m = Regex("^v?(\\d+)(?:\\.(\\d+))?(?:\\.(\\d+))?").find(name.trim()) ?: return -1
        val major = m.groupValues[1].toLongOrNull() ?: return -1
        val minor = m.groupValues[2].toLongOrNull() ?: 0
        val patch = m.groupValues[3].toLongOrNull() ?: 0
        return major * 1_000_000 + minor * 1_000 + patch
    }

    // ── Verification ────────────────────────────────────────────────────────

    /**
     * Structured outcome of verifying one candidate. Callers care about three cases:
     *  - [Ok] wins the probe;
     *  - [TooOld] does not, but is worth surfacing to the user (their Node just needs
     *    upgrading — much more actionable than a blanket "not found");
     *  - [NotUsable] is silently skipped (broken symlink, wrong arch, unrelated file).
     */
    private sealed class VerifyResult {
        data class Ok(val info: NodeInfo) : VerifyResult()
        data class TooOld(val path: String, val version: String) : VerifyResult()
        object NotUsable : VerifyResult()
    }

    /**
     * Proves a candidate actually runs by executing `<binPath> --version`. Existence or
     * canExecute alone is NOT sufficient (broken symlink targets, wrong-arch binaries).
     * A binary older than [MIN_SUPPORTED_MAJOR] runs but the bundled Cli.js cannot run
     * ON it, so it must not count as a usable detection — a newer install elsewhere can
     * still win as a later candidate. Too-old hits are returned as [VerifyResult.TooOld]
     * so [detect] can surface them for actionable UI messages.
     */
    private fun verify(binPath: String): VerifyResult {
        val f = File(binPath)
        if (!f.isFile || !f.canExecute()) return VerifyResult.NotUsable
        val version = probeVersion(f) ?: return VerifyResult.NotUsable
        val major = versionMajor(version) ?: return VerifyResult.NotUsable
        if (major < MIN_SUPPORTED_MAJOR) {
            log.info(
                "Rejecting %s: %s is below the minimum supported v%d",
                f.absolutePath, version, MIN_SUPPORTED_MAJOR,
            )
            return VerifyResult.TooOld(f.absolutePath, version)
        }
        return VerifyResult.Ok(NodeInfo(f.absolutePath, version))
    }

    /** Runs `<binary> --version` and returns the reported version, or null when it can't run. */
    private fun probeVersion(binary: File): String? {
        return try {
            val proc = ProcessBuilder(binary.absolutePath, "--version").redirectErrorStream(true).start()
            proc.outputStream.close()
            if (!proc.waitFor(VERSION_PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                proc.destroyForcibly()
                proc.waitFor(1, TimeUnit.SECONDS)
                return null
            }
            val out = proc.inputStream.bufferedReader().use { it.readText() }
            if (proc.exitValue() == 0) parseVersionOutput(out) else null
        } catch (_: Exception) {
            null
        }
    }

    /** Extracts the "vX.Y.Z" line from `node --version` output. */
    internal fun parseVersionOutput(output: String): String? =
        output.lineSequence()
            .map { it.trim() }
            .lastOrNull { it.matches(Regex("^v\\d+\\.\\d+\\.\\d+\\S*$")) }

    /** Major component of a "vX.Y.Z" version string, or null when unparseable. */
    internal fun versionMajor(version: String): Int? =
        Regex("^v(\\d+)\\.").find(version.trim())?.groupValues?.get(1)?.toIntOrNull()

    // ── Persistence (~/.jolli/jollimemory/node-info.json) ───────────────────

    private fun infoFile(): File = File(SessionTracker.getGlobalConfigDir(), INFO_FILE_NAME)

    /**
     * Persisted record shape: the info plus its source tag. Kept private so callers
     * (including tests) keep dealing with plain NodeInfo; only [detect] itself
     * needs the source, to preserve `"manual"` tags across fast-path rewrites when
     * the version has drifted (a Node upgrade under a manually-picked binary).
     */
    private data class RecordedRuntime(val info: NodeInfo, val source: String)

    /** Testable seam: reads a previously recorded detection, or `null` when absent/corrupt. */
    internal fun readRecordedInfo(file: File): NodeInfo? = readRecord(file)?.info

    private fun readRecord(file: File): RecordedRuntime? = try {
        if (!file.isFile) {
            null
        } else {
            val o = JsonParser.parseString(file.readText(Charsets.UTF_8)).asJsonObject
            val path = o.get("path")?.asString
            val version = o.get("version")?.asString
            val source = o.get("source")?.asString?.takeIf { it.isNotBlank() } ?: "auto"
            if (path.isNullOrBlank() || version.isNullOrBlank()) {
                null
            } else {
                RecordedRuntime(NodeInfo(path, version), source)
            }
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Testable seam: records a verified detection (path + version + timestamp).
     * [source] tags how the binary was found — "auto" (detection) or "manual"
     * (file-chooser pick) — for diagnostics; readers ignore it.
     *
     * The [PATH_FILE_NAME] sibling is written in lockstep so shell hook dispatchers
     * can fall back to this runtime when the git process PATH has no node (GUI git
     * clients). If the JSON write fails we also drop any pre-existing path file so
     * the two records can never disagree — a stale path pointing at a runtime the
     * IDE no longer trusts would let the dispatchers keep running an unverified
     * binary. If only the path write fails, we roll back the JSON for the same
     * reason.
     */
    internal fun writeRecordedInfo(file: File, info: NodeInfo, source: String = "auto") {
        val jsonOk = try {
            file.parentFile?.mkdirs()
            val o = JsonObject()
            o.addProperty("path", info.path)
            o.addProperty("version", info.version)
            o.addProperty("source", source)
            o.addProperty("detectedAt", java.time.Instant.now().toString())
            file.writeText(o.toString() + "\n", Charsets.UTF_8)
            true
        } catch (e: Exception) {
            log.warn("Failed to write %s: %s", INFO_FILE_NAME, e.message)
            false
        }
        if (!jsonOk) {
            deletePathFile(file)
            return
        }
        if (!writePathFile(file, info.path)) {
            // Roll back the JSON AND drop any stale path file so the two records
            // can never disagree — a leftover node-path would let the shell hook
            // dispatchers keep running a binary the IDE no longer trusts.
            try {
                file.delete()
            } catch (_: Exception) {
                // best-effort rollback
            }
            deletePathFile(file)
        }
    }

    /**
     * Writes the [PATH_FILE_NAME] sibling next to [recordFile] (one line: the bare path).
     * Returns true when the file was written, false on any IO failure — the caller uses
     * that signal to keep the JSON record in lockstep with the path record.
     */
    private fun writePathFile(recordFile: File, path: String): Boolean {
        return try {
            recordFile.parentFile?.mkdirs()
            File(recordFile.parentFile, PATH_FILE_NAME).writeText(path + "\n", Charsets.UTF_8)
            true
        } catch (e: Exception) {
            log.warn("Failed to write %s: %s", PATH_FILE_NAME, e.message)
            false
        }
    }

    /** Removes the [PATH_FILE_NAME] sibling next to [recordFile] (best-effort). */
    private fun deletePathFile(recordFile: File) {
        try {
            File(recordFile.parentFile, PATH_FILE_NAME).delete()
        } catch (_: Exception) {
            // best-effort cleanup
        }
    }
}
