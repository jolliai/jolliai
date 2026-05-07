package ai.jolli.jollimemory.services

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * PrService — Kotlin port of PrCommentService.ts
 *
 * Self-contained module for PR creation and update operations.
 *
 * Responsibilities:
 * - gh CLI interaction (availability, auth, PR lookup, description edit)
 * - Dual-marker summary embedding in PR Description
 * - Branch operations (push, commit count, current branch)
 *
 * All GitHub/git operations go through the `gh` / `git` CLI — no extra dependencies.
 */
object PrService {

    private val log = JmLogger.create("PrService")

    /** PR metadata returned by `findPrForBranch`. */
    data class PrInfo(
        val number: Int,
        val url: String,
        val title: String,
        val body: String,
    )

    private const val MARKER_START = "<!-- jollimemory-summary-start -->"
    private const val MARKER_END = "<!-- jollimemory-summary-end -->"
    private val MARKER_PATTERN = Regex("<!-- jollimemory-summary-start -->[\\s\\S]*?<!-- jollimemory-summary-end -->")

    // ── CLI helpers ─────────────────────────────────────────────────────────

    private val isWindows = System.getProperty("os.name").lowercase().contains("win")

    /**
     * Resolves the user's full PATH. IntelliJ's JVM process has a minimal PATH
     * that may not include Homebrew (macOS/Linux) or user-scoped installs (Windows).
     *
     * On Unix, runs a one-time login shell to capture the full PATH from the
     * user's shell profile (~/.zshrc, ~/.bash_profile, etc.).
     *
     * On Windows, starts from the system PATH and appends Git's usr/bin so
     * utilities like sed/awk are available to git hooks.
     *
     * Follows the same pattern as GitOps.shellPath.
     */
    private val resolvedPath: String by lazy {
        try {
            if (isWindows) {
                resolveWindowsPath()
            } else {
                val shell = System.getenv("SHELL")
                    ?.takeIf { it.isNotBlank() && File(it).canExecute() }
                    ?: "/bin/zsh"
                val proc = ProcessBuilder(shell, "-l", "-c", "echo \$PATH")
                    .redirectErrorStream(true)
                    .start()
                val output = proc.inputStream.bufferedReader().use { it.readText().trim() }
                proc.waitFor(5, TimeUnit.SECONDS)
                if (output.isNotBlank()) output else System.getenv("PATH") ?: ""
            }
        } catch (_: Exception) {
            System.getenv("PATH") ?: ""
        }
    }

    /** On Windows, appends Git's usr/bin to the system PATH (for sed, awk, etc.). */
    private fun resolveWindowsPath(): String {
        val basePath = System.getenv("PATH") ?: ""
        try {
            val proc = ProcessBuilder("where", "git")
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().use { it.readText().trim() }
            proc.waitFor(5, TimeUnit.SECONDS)

            val gitExePath = output.lines().firstOrNull { it.endsWith("git.exe") }
            if (gitExePath != null) {
                val gitRoot = File(gitExePath).parentFile?.parentFile
                if (gitRoot != null) {
                    val usrBin = File(gitRoot, "usr${File.separator}bin")
                    if (usrBin.isDirectory) {
                        return "$basePath${File.pathSeparator}${usrBin.absolutePath}"
                    }
                }
            }
        } catch (_: Exception) { }
        return basePath
    }

    /**
     * Runs a CLI command directly via ProcessBuilder and returns stdout,
     * or null on failure. Uses [resolvedPath] so that tools like `gh` and
     * `git` installed via Homebrew (macOS/Linux) or user-scoped installers
     * (Windows) are found. No shell wrapper or quoting needed — each argument
     * is passed directly to the OS process.
     */
    private fun execCommand(
        command: String,
        args: List<String>,
        cwd: String,
        timeoutSeconds: Long = 30,
    ): String? {
        return try {
            val pb = ProcessBuilder(listOf(command) + args)
                .directory(File(cwd))
                .redirectErrorStream(false)
            pb.environment()["PATH"] = resolvedPath

            val process = pb.start()

            // Read stdout and stderr concurrently to avoid pipe buffer deadlock
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().use { it.readText().trim() }
            }
            val stderrFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.errorStream.bufferedReader().use { it.readText().trim() }
            }

            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                log.warn("execCommand: timed out after %ds: %s %s", timeoutSeconds, command, args.joinToString(" "))
                return null
            }

            val exitCode = process.exitValue()
            if (exitCode != 0) {
                val stderr = stderrFuture.get(5, java.util.concurrent.TimeUnit.SECONDS)
                log.warn("execCommand: exit=%d cmd='%s %s' stderr='%s'", exitCode, command, args.joinToString(" "), stderr)
                return null
            }
            stdoutFuture.get(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: Exception) {
            log.warn("execCommand: exception for '%s %s': %s", command, args.joinToString(" "), e.message ?: e.toString())
            null
        }
    }

    /** Runs a gh command and returns stdout, or null on failure. */
    private fun execGh(args: List<String>, cwd: String): String? {
        return execCommand("gh", args, cwd)
    }

    /** Runs a gh command and returns stdout. Throws on failure. */
    private fun execGhOrThrow(args: List<String>, cwd: String): String {
        return execGh(args, cwd)
            ?: throw RuntimeException("gh command failed: gh ${args.joinToString(" ")}\n\nCheck: Is 'gh' installed? Is it authenticated (gh auth login)? Is the branch pushed to remote?")
    }

    /** Runs a git command and returns stdout, or null on failure. */
    private fun execGit(args: List<String>, cwd: String): String? {
        return execCommand("git", args, cwd)
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /** Checks whether the `gh` CLI is installed and reachable. */
    fun isGhAvailable(cwd: String): Boolean {
        return execGh(listOf("--version"), cwd) != null
    }

    /** Checks whether `gh` is authenticated (logged in). */
    fun isGhAuthenticated(cwd: String): Boolean {
        return execGh(listOf("auth", "status"), cwd) != null
    }

    /** Returns the number of commits on the current branch relative to origin/main. */
    fun getCommitCount(cwd: String): Int {
        return try {
            val raw = execGit(listOf("rev-list", "--count", "origin/main..HEAD"), cwd) ?: return 0
            raw.toIntOrNull() ?: 0
        } catch (_: Exception) {
            0
        }
    }

    /** Returns the current branch name. */
    fun getCurrentBranch(cwd: String): String? {
        return execGit(listOf("rev-parse", "--abbrev-ref", "HEAD"), cwd)
    }

    /**
     * Returns PR info for the current branch, or null if none exists.
     * Uses `gh pr view` to fetch the PR associated with the current branch.
     */
    fun findPrForBranch(cwd: String): PrInfo? {
        val raw = execGh(listOf("pr", "view", "--json", "number,url,title,body"), cwd) ?: return null

        return try {
            @Suppress("UNCHECKED_CAST")
            val json = com.google.gson.Gson().fromJson(raw, Map::class.java) as Map<String, Any?>
            val number = (json["number"] as? Double)?.toInt() ?: return null
            if (number == 0) return null

            PrInfo(
                number = number,
                url = json["url"] as? String ?: "",
                title = json["title"] as? String ?: "",
                body = json["body"] as? String ?: "",
            )
        } catch (_: Exception) {
            null
        }
    }

    /** Pushes the current branch to origin (sets upstream tracking). */
    fun pushBranch(cwd: String) {
        val result = execGit(listOf("push", "-u", "origin", "HEAD"), cwd)
        if (result == null) {
            log.warn("Push may have failed, but stderr output is common for push")
        }
    }

    /**
     * Creates a new PR via `gh pr create`. Returns the new PR URL.
     *
     * Uses a temp file for the body to avoid shell escaping issues
     * with complex markdown content.
     */
    fun createPr(title: String, body: String, cwd: String): String {
        val tmpFile = writeTempFile(body)
        try {
            val output = execGhOrThrow(
                listOf("pr", "create", "--title", title, "--body-file", tmpFile.absolutePath),
                cwd,
            )
            return output.trim()
        } finally {
            removeTempFile(tmpFile)
        }
    }

    /**
     * Updates an existing PR's title and/or body.
     *
     * @param prNumber The PR number to update
     * @param title New title, or null to leave unchanged
     * @param body New body content
     * @param cwd Working directory
     */
    fun updatePr(prNumber: Int, title: String?, body: String, cwd: String) {
        // Update title if provided
        if (title != null) {
            execGhOrThrow(listOf("pr", "edit", prNumber.toString(), "--title", title), cwd)
        }

        // Update body via temp file
        val tmpFile = writeTempFile(body)
        try {
            execGhOrThrow(
                listOf("pr", "edit", prNumber.toString(), "--body-file", tmpFile.absolutePath),
                cwd,
            )
        } finally {
            removeTempFile(tmpFile)
        }
    }

    // ── Marker helpers ──────────────────────────────────────────────────────

    /** Wraps markdown content with start/end markers. */
    fun wrapWithMarkers(markdown: String): String {
        return "$MARKER_START\n$markdown\n$MARKER_END"
    }

    /**
     * Replaces the marker region in body, or appends if no markers found.
     * Used to embed/update the JolliMemory summary section in a PR description.
     */
    fun replaceSummaryInBody(currentBody: String, newMarkdown: String): String {
        val wrapped = wrapWithMarkers(newMarkdown)
        return if (MARKER_PATTERN.containsMatchIn(currentBody)) {
            // Use lambda form to avoid $/$n and \ being interpreted as regex backreferences
            MARKER_PATTERN.replace(currentBody) { wrapped }
        } else if (currentBody.isNotEmpty()) {
            "$currentBody\n\n$wrapped"
        } else {
            wrapped
        }
    }

    // ── Temp file helpers ───────────────────────────────────────────────────

    /** Writes content to a unique temp file and returns the File object. */
    private fun writeTempFile(content: String): File {
        val tmpFile = File.createTempFile("jollimemory-pr-", ".md")
        tmpFile.writeText(content, Charsets.UTF_8)
        return tmpFile
    }

    /** Safely removes a temp file. */
    private fun removeTempFile(file: File) {
        try {
            file.delete()
        } catch (_: Exception) {
            // Already gone -- harmless
        }
    }
}
