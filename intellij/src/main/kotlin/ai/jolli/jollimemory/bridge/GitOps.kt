package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.JmLogger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Native git operations using the system `git` binary.
 *
 * Git is universally available on developer machines — no Node.js needed.
 * Uses IntelliJ's bundled git if available, falls back to system git.
 *
 * IDE-only surface: reads for the tool-window/panels and short user-triggered
 * git actions. Domain-level orphan-branch I/O has moved to the CLI via
 * `jolli ide-bridge git-exec`; keep this class limited to display-time reads.
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
            if (System.getProperty("os.name").lowercase().contains("win")) {
                resolveWindowsPath()
            } else {
                val shell = System.getenv("SHELL") ?: "/bin/zsh"
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

    /**
     * On Windows, the system PATH usually has Git's cmd/ dir but not usr/bin/
     * where tools like sed and awk live. Find the Git install root and append
     * usr/bin so git hooks that need those tools work correctly.
     */
    private fun resolveWindowsPath(): String {
        val basePath = System.getenv("PATH") ?: ""
        try {
            val proc = ProcessBuilder("where", "git")
                .redirectErrorStream(true)
                .start()
            val output = proc.inputStream.bufferedReader().use { it.readText().trim() }
            proc.waitFor(5, TimeUnit.SECONDS)

            // Find Git install root from the first git.exe path
            // e.g. "C:\Program Files\Git\cmd\git.exe" -> "C:\Program Files\Git"
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

    /** Full result of a git invocation — exit code plus captured stdout and stderr. */
    data class ExecResult(val exitCode: Int, val stdout: String, val stderr: String)

    /**
     * Runs a git command and returns the full [ExecResult] (exit code, stdout, stderr).
     * Callers that need to classify failures (e.g. non-fast-forward detection) use this
     * instead of [exec] which discards stderr on failure.
     */
    fun execWithResult(vararg args: String, timeoutSeconds: Long = 15, trim: Boolean = true): ExecResult {
        return try {
            val cmdArgs = mutableListOf("git")
            cmdArgs.addAll(args)

            val pb = ProcessBuilder(cmdArgs)
                .directory(File(projectDir))
                .redirectErrorStream(false)
            pb.environment()["PATH"] = shellPath
            val process = pb.start()

            // Read stdout and stderr concurrently to avoid pipe buffer deadlock.
            val stdoutFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            }
            val stderrFuture = java.util.concurrent.CompletableFuture.supplyAsync {
                process.errorStream.bufferedReader(Charsets.UTF_8).use { it.readText().trim() }
            }

            val completed = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)
            if (!completed) {
                process.destroyForcibly()
                stdoutFuture.cancel(true)
                stderrFuture.cancel(true)
                log.warn("Git command timed out: %s (cwd=%s)", args.toList(), projectDir)
                return ExecResult(-1, "", "Timed out after ${timeoutSeconds}s")
            }

            val exitCode = process.exitValue()
            val stdout = stdoutFuture.get(5, TimeUnit.SECONDS)
            val stderr = stderrFuture.get(5, TimeUnit.SECONDS)
            if (exitCode != 0) {
                log.warn("Git command exit=%d: %s stderr=%s (cwd=%s)", exitCode, args.toList(), stderr.take(200), projectDir)
            }
            val out = if (trim) stdout.trim() else stdout.trimEnd()
            ExecResult(exitCode, out, stderr)
        } catch (e: Exception) {
            log.warn("Git command exception: %s: %s (cwd=%s)", args.toList(), e.message, projectDir)
            ExecResult(-1, "", e.message ?: e.toString())
        }
    }

    /**
     * Runs a git command and returns stdout, or null on failure.
     * Delegates to [execWithResult] — use that directly when stderr is needed.
     */
    fun exec(vararg args: String, timeoutSeconds: Long = 15, trim: Boolean = true): String? {
        val result = execWithResult(*args, timeoutSeconds = timeoutSeconds, trim = trim)
        return if (result.exitCode == 0) result.stdout else null
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

    /** List local branch names, current branch first. */
    fun listBranches(): List<String> {
        val output = exec("branch", "--format=%(refname:short)") ?: return emptyList()
        val branches = output.lines().filter { it.isNotBlank() }
        val current = getCurrentBranch()
        return if (current != null) {
            listOf(current) + branches.filter { it != current }
        } else {
            branches
        }
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

    /**
     * Get diff content for a commit (defaults to HEAD). Pass a specific [ref] when
     * the queue drains a commit that is no longer HEAD — the diff must be that
     * commit's own change, not whatever HEAD points at now. A root commit (no
     * parent) has no `<ref>~1`, so fall back to `git show` against the empty tree.
     */
    fun getDiffContent(ref: String = "HEAD"): String? {
        return if (hasParent(ref)) exec("diff", "$ref~1..$ref")
        else exec("show", "--format=", ref)
    }

    /**
     * Returns the changed file paths for a commit (defaults to HEAD), forward-slash
     * separated (git already emits forward slashes). Empty list on failure or when a
     * root commit has no parent diff. Used by the context-relevance change signal.
     */
    fun getChangedFileNames(ref: String = "HEAD"): List<String> {
        val output = if (hasParent(ref)) {
            exec("diff", "--name-only", "$ref~1..$ref")
        } else {
            exec("show", "--name-only", "--format=", ref)
        } ?: return emptyList()
        return output.lines().map { it.trim() }.filter { it.isNotEmpty() }
    }

    /** Get diff stats for a commit (defaults to HEAD). See [getDiffContent] for the [ref] rationale. */
    fun getDiffStats(ref: String = "HEAD"): String? {
        return if (hasParent(ref)) exec("diff", "--stat", "--numstat", "$ref~1..$ref")
        else exec("show", "--stat", "--numstat", "--format=", ref)
    }

    /** True when [ref] has a first parent (so `<ref>~1` resolves). */
    private fun hasParent(ref: String): Boolean = exec("rev-parse", "--verify", "-q", "$ref~1") != null

    /** Get commit info (hash subject author authorDate) for [ref] (defaults to HEAD). */
    fun getHeadCommitInfo(ref: String = "HEAD"): String? {
        return exec("log", "-1", "--pretty=format:%H%x00%s%x00%an%x00%aI", ref)
    }

    /** Get HEAD hash. */
    fun getHeadHash(): String? {
        return exec("rev-parse", "HEAD")
    }

    /**
     * Get git status in NUL-separated porcelain format (preserves leading spaces in
     * status codes). `-uall` lists every file inside a freshly created directory
     * individually instead of collapsing them into one `?? dir/` row; `-z` makes
     * entries NUL-separated so paths with spaces and rename pairs parse unambiguously.
     * Mirrors the VS Code bridge's `listFiles` flags.
     */
    fun getStatus(): String? {
        return exec("status", "-z", "--porcelain=v1", "-uall", trim = false)
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

    /** True when [ancestor] is an ancestor of (or equal to) [descendant]. */
    fun isAncestor(ancestor: String, descendant: String): Boolean {
        // `merge-base --is-ancestor` exits 0 when true, non-zero when false;
        // exec() returns "" on exit 0 and null on a non-zero exit.
        return exec("merge-base", "--is-ancestor", ancestor, descendant) != null
    }

    /**
     * Uses git reflog to find the commit where [branch] was originally created.
     * Returns the hash at creation, or null when the reflog has expired or is
     * unavailable (e.g. after a fresh clone).
     *
     * When [requireExplicit] is true, returns null unless an explicit
     * "branch: Created from …" entry is found. Reflog entries expire oldest-first,
     * so once the creation entry is gone the oldest surviving entry is often the
     * branch's own first commit — guessing it as the creation point would silently
     * drop that commit from history. Callers feeding history decisions pass true so
     * they degrade to a safe base instead of trusting a guess. Mirrors the VS Code
     * bridge's findBranchCreationPoint.
     */
    fun findBranchCreationPoint(branch: String, requireExplicit: Boolean = false): String? {
        // Detached HEAD has no branch reflog of its own — `reflog show HEAD` would
        // surface HEAD's whole movement history (oldest entry = the repo's first
        // commit), which is not a creation point. Bail rather than mislead.
        if (branch == "HEAD") return null
        val reflog = exec("reflog", "show", branch, "--format=%H %gs") ?: return null
        val lines = reflog.lines().filter { it.isNotBlank() }
        if (lines.isEmpty()) return null

        // Explicit "branch: Created from ..." entry (scan from oldest).
        for (i in lines.indices.reversed()) {
            if (lines[i].contains("branch: Created from")) {
                return lines[i].substringBefore(" ").takeIf { it.isNotBlank() }
            }
        }

        // No explicit creation record. Only guess the oldest surviving entry when
        // the caller tolerates it (see requireExplicit).
        if (requireExplicit) return null
        return lines.last().substringBefore(" ").takeIf { it.isNotBlank() }
    }

    /** Reflog-derived merged-history result: log-range base + whether the branch authored anything. */
    data class MergedHistory(val base: String, val hasOwnCommit: Boolean)

    /**
     * Resolves what the merged-mode history view needs from [branch]'s reflog: the
     * log-range base (where the branch was created) and whether the branch ever
     * committed anything of its own.
     *
     * Used when HEAD is fully contained in the mainline (`merge-base HEAD base ==
     * HEAD`) — e.g. on `main` in a repo with no remote — so the panel can still show
     * the user's own commits (`<base>..HEAD --author=<you>`) instead of an empty
     * list. [hasOwnCommit] keys on a `commit` reflog op: a branch showing only
     * creation + rebase/reset/checkout never authored anything itself, so the caller
     * shows an empty panel rather than re-listing commits that belong to the base.
     *
     * Returns null for detached HEAD or when the reflog is unavailable/expired —
     * same graceful-degradation boundary [findBranchCreationPoint] uses. Mirrors the
     * VS Code bridge's resolveMergedHistory.
     */
    fun resolveMergedHistory(branch: String): MergedHistory? {
        if (branch == "HEAD") return null
        val reflog = exec("reflog", "show", branch, "--format=%H %gs") ?: return null
        val lines = reflog.lines().filter { it.isNotBlank() }
        if (lines.isEmpty()) return null

        // Base: the explicit "branch: Created from …" entry if present (scan from
        // oldest), else the oldest surviving entry — the same best-effort fallback
        // the non-strict findBranchCreationPoint uses.
        var base: String? = null
        for (i in lines.indices.reversed()) {
            if (lines[i].contains("branch: Created from")) {
                base = lines[i].substringBefore(" ").takeIf { it.isNotBlank() }
                break
            }
        }
        if (base == null) base = lines.last().substringBefore(" ").takeIf { it.isNotBlank() }
        val resolvedBase = base ?: return null

        // Own commit = a `commit` reflog op ("commit:", "commit (amend):",
        // "commit (initial):"). The subject follows the leading "<hash> ".
        val hasOwnCommit = lines.any { Regex("^[0-9a-f]+ commit\\b").containsMatchIn(it) }
        return MergedHistory(resolvedBase, hasOwnCommit)
    }

    /** Current `git config user.name` (for the merged-mode `--author` filter); null when unset/blank. */
    fun getCurrentUserName(): String? = exec("config", "user.name")?.trim()?.takeIf { it.isNotBlank() }

    /**
     * Resolves the base commit that "own commits" on [branch] are measured from.
     *
     * Own commits should be counted from where the branch was actually cut, not
     * from the mainline. A branch freshly created from a feature/release branch
     * starts with its tip equal to that base branch's tip — comparing against main
     * would wrongly count the base branch's shared commits (and a brand-new
     * branch's inherited history) as this branch's own work.
     *
     * Prefers the branch's reflog creation point when it sits downstream of (is a
     * descendant of) the mainline merge-base. Falls back to [mergeBaseMain] when
     * the creation point is unavailable (reflog expired), equals it (cut directly
     * from main), or is no longer an ancestor of HEAD (stale after reset --hard /
     * rebase --onto). When the mainline ref is unresolvable ([mergeBaseMain] is
     * empty) the validated creation point is used directly. Mirrors the VS Code
     * bridge's resolveOwnCommitsBase.
     */
    fun resolveOwnCommitsBase(branch: String, mergeBaseMain: String): String {
        val creationPoint = findBranchCreationPoint(branch, requireExplicit = true) ?: return mergeBaseMain
        // Cut directly from main: mergeBaseMain is already an ancestor of HEAD.
        if (creationPoint == mergeBaseMain) return mergeBaseMain
        // A stale creation point (after reset/rebase --onto) is no longer behind
        // HEAD — `<stalePoint>..HEAD` would be meaningless. Fall back to mainline.
        if (!isAncestor(creationPoint, "HEAD")) return mergeBaseMain
        // Mainline unresolvable (e.g. master/trunk default with no origin): trust
        // the validated fork point directly.
        if (mergeBaseMain.isEmpty()) return creationPoint
        // Adopt the creation point only when downstream of the mainline merge-base
        // (the "cut from release/develop" case).
        return if (isAncestor(mergeBaseMain, creationPoint)) creationPoint else mergeBaseMain
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
