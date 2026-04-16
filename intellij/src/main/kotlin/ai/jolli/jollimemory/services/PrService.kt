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

    /**
     * Detects the user's login shell. IntelliJ's JVM process has a minimal
     * PATH that doesn't include Homebrew or other user-installed directories.
     * Running commands through a login shell (`-lc`) sources the user's shell
     * profile (~/.zshrc, ~/.bash_profile, etc.) which sets up the full PATH —
     * matching the behavior of VS Code's Node.js `execFile` which inherits
     * the login shell environment.
     */
    private val loginShell: String by lazy {
        val shell = System.getenv("SHELL")
        if (!shell.isNullOrBlank() && File(shell).canExecute()) shell else "/bin/zsh"
    }

    /**
     * Runs a CLI command through the user's login shell and returns stdout,
     * or null on failure. Using a login shell (`-lc`) ensures the full PATH
     * from the user's shell profile is available, so tools like `gh` and `git`
     * installed via Homebrew are found.
     */
    private fun execCommand(
        command: String,
        args: List<String>,
        cwd: String,
        timeoutSeconds: Long = 30,
    ): String? {
        return try {
            // Build a single shell command string with proper quoting
            val shellCmd = (listOf(command) + args).joinToString(" ") { shellQuote(it) }

            val process = ProcessBuilder(loginShell, "-lc", shellCmd)
                .directory(File(cwd))
                .redirectErrorStream(false)
                .start()

            // Read stdout concurrently to avoid pipe buffer deadlock
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader().use { it.readText().trim() }
            }

            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                return null
            }

            if (process.exitValue() != 0) return null
            stdoutFuture.get(5, java.util.concurrent.TimeUnit.SECONDS)
        } catch (e: Exception) {
            log.debug("Command failed: $command ${args.joinToString(" ")}: ${e.message}")
            null
        }
    }

    /** Shell-quotes a single argument (wraps in single quotes, escaping internal single quotes). */
    private fun shellQuote(arg: String): String {
        if (arg.isEmpty()) return "''"
        // If the arg contains no special characters, return as-is
        if (arg.matches(Regex("[a-zA-Z0-9_./:@=-]+"))) return arg
        // Wrap in single quotes, escaping any embedded single quotes
        return "'" + arg.replace("'", "'\\''") + "'"
    }

    /** Runs a gh command and returns stdout, or null on failure. */
    private fun execGh(args: List<String>, cwd: String): String? {
        return execCommand("gh", args, cwd)
    }

    /** Runs a gh command and returns stdout. Throws on failure. */
    private fun execGhOrThrow(args: List<String>, cwd: String): String {
        return execGh(args, cwd)
            ?: throw RuntimeException("gh command failed: gh ${args.joinToString(" ")}")
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
