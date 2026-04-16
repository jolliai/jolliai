package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Native git operations using the system `git` binary.
 *
 * Git is universally available on developer machines — no Node.js needed.
 * Uses IntelliJ's bundled git if available, falls back to system git.
 */
class GitOps(private val projectDir: String) {

    private val log = JmLogger.create("GitOps")

    /**
     * Resolves the user's full PATH by sourcing their login shell profile.
     * IntelliJ's ProcessBuilder does not inherit nvm/homebrew paths, so
     * git hooks that call `node` fail with "command not found". This
     * runs a login shell once to capture the real PATH and caches it.
     */
    private val shellPath: String by lazy {
        try {
            val shell = System.getenv("SHELL") ?: "/bin/zsh"
            val proc = ProcessBuilder(shell, "-l", "-c", "echo \$PATH")
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().use { it.readText().trim() }
            proc.waitFor(5, TimeUnit.SECONDS)
            if (output.isNotBlank()) output else System.getenv("PATH") ?: ""
        } catch (_: Exception) {
            System.getenv("PATH") ?: ""
        }
    }

    /**
     * Runs a git command and returns stdout, or null on failure.
     */
    fun exec(vararg args: String, timeoutSeconds: Long = 15, trim: Boolean = true): String? {
        return try {
            val cmdArgs = mutableListOf("git")
            cmdArgs.addAll(args)

            val pb = ProcessBuilder(cmdArgs)
                .directory(File(projectDir))
                .redirectErrorStream(false)
            // Inject the user's full PATH so git hooks can find node (nvm/homebrew)
            pb.environment()["PATH"] = shellPath
            val process = pb.start()

            // Read stdout on a separate thread to avoid pipe buffer deadlock.
            // If stdout exceeds the OS pipe buffer (~64 KB) and we wait for the
            // process to finish before reading, the process blocks on write and
            // we block on waitFor → deadlock → timeout.
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            }

            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                stdoutFuture.cancel(true)
                log.warn("Git command timed out: %s (cwd=%s)", args.toList(), projectDir)
                return null
            }

            if (process.exitValue() != 0) {
                val stderr = process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
                log.warn("Git command exit=%d: %s stderr=%s (cwd=%s)", process.exitValue(), args.toList(), stderr.take(200), projectDir)
                return null
            }
            val output = stdoutFuture.get(5, TimeUnit.SECONDS)
            if (trim) output?.trim() else output?.trimEnd()
        } catch (e: Exception) {
            log.warn("Git command exception: %s: %s (cwd=%s)", args.toList(), e.message, projectDir)
            null
        }
    }

    /** Check if a branch exists. */
    fun branchExists(branchName: String): Boolean {
        return exec("rev-parse", "--verify", "refs/heads/$branchName") != null
    }

    /** List files in an orphan branch under a prefix. */
    fun listBranchFiles(branch: String, prefix: String): List<String> {
        val output = exec("ls-tree", "-r", "--name-only", branch, prefix) ?: return emptyList()
        return output.lines().filter { it.isNotBlank() }
    }

    /** Read a file from an orphan branch. */
    fun readBranchFile(branch: String, path: String): String? {
        return exec("show", "$branch:$path")
    }

    /** Get current branch name. */
    fun getCurrentBranch(): String? {
        return exec("rev-parse", "--abbrev-ref", "HEAD")
    }

    /** Get commits on current branch not in main. */
    fun getBranchCommits(baseBranch: String = "main"): String? {
        return exec("log", "$baseBranch..HEAD", "--format=%H|%h|%s|%an|%aI", "--no-merges")
    }

    /** Execute a git command with stdin input and return stdout. */
    fun execWithStdin(vararg args: String, input: String, timeoutSeconds: Long = 15): String? {
        return try {
            val cmdArgs = mutableListOf("git")
            cmdArgs.addAll(args)

            val pb = ProcessBuilder(cmdArgs)
                .directory(File(projectDir))
                .redirectErrorStream(false)
            pb.environment()["PATH"] = shellPath
            val process = pb.start()

            // Write input to stdin (explicit UTF-8 to prevent encoding corruption)
            process.outputStream.bufferedWriter(Charsets.UTF_8).use { writer ->
                writer.write(input)
            }

            // Read stdout concurrently to avoid pipe buffer deadlock
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
            }

            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                stdoutFuture.cancel(true)
                return null
            }

            if (process.exitValue() != 0) return null
            stdoutFuture.get(5, TimeUnit.SECONDS)
        } catch (e: Exception) {
            log.debug("Git command with stdin failed: ${args.toList()}: ${e.message}")
            null
        }
    }

    /** Get diff content for HEAD commit. */
    fun getDiffContent(): String? {
        return exec("diff", "HEAD~1..HEAD")
    }

    /** Get diff stats for HEAD commit. */
    fun getDiffStats(): String? {
        return exec("diff", "--stat", "--numstat", "HEAD~1..HEAD")
    }

    /** Get HEAD commit info. */
    fun getHeadCommitInfo(): String? {
        return exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI")
    }

    /** Get HEAD hash. */
    fun getHeadHash(): String? {
        return exec("rev-parse", "HEAD")
    }

    /** Get git status in porcelain format (preserves leading spaces in status codes). */
    fun getStatus(): String? {
        return exec("status", "--porcelain=v1", trim = false)
    }

    /**
     * Captures the current index state as a tree object SHA.
     * Used to snapshot and later restore the index on cancel/error.
     */
    fun writeTree(): String? {
        return exec("write-tree")?.trim()?.takeIf { it.isNotBlank() }
    }

    /**
     * Restores the index to a previously captured tree SHA (from [writeTree]).
     * Returns true on success.
     */
    fun readTree(treeSha: String): Boolean {
        return exec("read-tree", treeSha) != null
    }

    /** Returns the list of currently staged file paths (relative to repo root). */
    fun getStagedFilePaths(): List<String> {
        val output = exec("diff", "--cached", "--name-only") ?: return emptyList()
        return output.lines().filter { it.isNotBlank() }
    }

    /** Stages one or more files in a single git command. */
    fun stageFiles(paths: List<String>) {
        if (paths.isEmpty()) return
        exec(*( listOf("add", "--") + paths ).toTypedArray())
    }

    /** Unstages one or more tracked files in a single git command. */
    fun unstageFiles(paths: List<String>) {
        if (paths.isEmpty()) return
        exec(*( listOf("restore", "--staged", "--") + paths ).toTypedArray())
    }

    /**
     * Checks if HEAD has been pushed to the remote tracking branch.
     * Returns true if the remote contains HEAD's commit.
     */
    fun isHeadPushed(): Boolean {
        val upstream = exec("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")?.trim()
        if (upstream.isNullOrBlank()) return false
        val headHash = getHeadHash() ?: return false
        val result = exec("merge-base", "--is-ancestor", headHash, upstream)
        return result != null
    }

    /** Resolve the main worktree root (handles worktrees). */
    fun resolveMainWorktreeRoot(): String? {
        val gitFile = File(projectDir, ".git")
        if (gitFile.isFile) {
            // Worktree: .git is a file with "gitdir: /path/to/main/.git/worktrees/<name>"
            try {
                val gitdirLine = gitFile.readText().trim()
                if (gitdirLine.startsWith("gitdir:")) {
                    val gitdirPath = gitdirLine.removePrefix("gitdir:").trim()
                    return File(gitdirPath).parentFile?.parentFile?.parentFile?.absolutePath
                }
            } catch (_: Exception) { }
        }
        return projectDir
    }
}
