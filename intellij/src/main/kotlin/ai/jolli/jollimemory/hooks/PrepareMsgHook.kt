package ai.jolli.jollimemory.hooks

import ai.jolli.jollimemory.bridge.GitOps
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import java.io.File

/**
 * PrepareMsgHook — Kotlin port of PrepareMsgHook.ts
 *
 * Handles three scenarios before a commit is created:
 *   1. git merge --squash (source = "squash")
 *   2. git commit --amend (source = "commit", oldHash = HEAD)
 *   3. git reset --soft + commit (reset-squash detection)
 */
object PrepareMsgHook {

    private val log = JmLogger.create("PrepareMsgHook")

    fun run(args: Array<String>) {
        val cwd = System.getProperty("user.dir")
        JmLogger.setLogDir(cwd)
        log.info("=== Prepare-commit-msg hook started (source: %s) ===", args.getOrNull(1) ?: "unknown")

        val source = args.getOrNull(1) // "squash", "commit", "message", etc.
        val oldHash = args.getOrNull(2)
        val git = GitOps(cwd)

        try {
            when (source) {
                "squash" -> handleSquash(cwd, git)
                "commit" -> handleAmend(cwd, git, oldHash)
                else -> {
                    // Detect reset-squash: git reset --soft HEAD~N && git commit
                    // The reflog's latest entry starts with "reset:" when this happens.
                    if (source == "message" || source == null) {
                        handleResetSquash(cwd, git)
                    }
                }
            }
        } catch (e: Exception) {
            log.error("PrepareMsgHook error: %s", e.message)
        }

        log.info("=== Prepare-commit-msg hook finished ===")
    }

    private fun handleSquash(cwd: String, git: GitOps) {
        // Read SQUASH_MSG to extract source commit hashes.
        // In worktrees, .git is a pointer file ("gitdir: ..."), so resolve the actual git dir.
        val squashMsgFile = resolveGitFile(cwd, "SQUASH_MSG")
        if (!squashMsgFile.exists()) {
            log.warn("SQUASH_MSG not found")
            return
        }

        val content = squashMsgFile.readText()
        val hashPattern = Regex("^commit ([0-9a-f]{40})", RegexOption.MULTILINE)
        val hashes = hashPattern.findAll(content).map { it.groupValues[1] }.toList()

        if (hashes.isEmpty()) {
            log.warn("No commit hashes found in SQUASH_MSG")
            return
        }

        val headHash = git.getHeadHash() ?: return
        SessionTracker.saveSquashPending(hashes, headHash, cwd)
        log.info("Squash pending saved: %d source hashes", hashes.size)
    }

    private fun handleAmend(cwd: String, git: GitOps, oldHash: String?) {
        val headHash = git.getHeadHash() ?: return

        // If oldHash matches HEAD, this is a --amend
        if (oldHash != null && oldHash == headHash) {
            SessionTracker.saveAmendPending(headHash, cwd)
            log.info("Amend pending saved: %s", headHash.take(8))
        }
    }

    /**
     * Detects `git reset --soft HEAD~N && git commit` (reset-squash).
     * The reflog's latest entry starts with "reset:" when this happens.
     * We extract the hashes of the reset-away commits and save squash-pending.
     */
    private fun handleResetSquash(cwd: String, git: GitOps) {
        val reflogEntry = git.exec("reflog", "-1", "--format=%gs") ?: return
        if (!reflogEntry.startsWith("reset:")) {
            log.debug("Reflog latest entry is not a reset (%s) — skipping reset-squash detection", reflogEntry)
            return
        }

        // Find the pre-reset HEAD from reflog entry at position 1 (HEAD@{1})
        val preResetHash = git.exec("rev-parse", "HEAD@{1}") ?: return
        val currentHash = git.getHeadHash() ?: return

        // Get commits between current HEAD and pre-reset HEAD (the ones being squashed)
        val logOutput = git.exec("log", "--format=%H", "$currentHash..$preResetHash") ?: return
        val sourceHashes = logOutput.lines().filter { it.isNotBlank() }

        if (sourceHashes.isEmpty()) {
            log.debug("No commits between current HEAD and pre-reset HEAD — not a reset-squash")
            return
        }

        SessionTracker.saveSquashPending(sourceHashes, currentHash, cwd)
        log.info("Reset-squash detected: %d source hashes from reset", sourceHashes.size)
    }

    /**
     * Resolves a file inside the git directory, handling worktrees correctly.
     * In a worktree, `.git` is a pointer file containing "gitdir: /path/to/...".
     * Files like SQUASH_MSG live in that resolved gitdir, not under `cwd/.git/`.
     */
    private fun resolveGitFile(cwd: String, fileName: String): File {
        val dotGit = File(cwd, ".git")
        if (dotGit.isFile) {
            // Worktree: .git is a file with "gitdir: <path>"
            try {
                val line = dotGit.readText().trim()
                if (line.startsWith("gitdir:")) {
                    val gitDir = File(line.removePrefix("gitdir:").trim())
                    return File(gitDir, fileName)
                }
            } catch (_: Exception) { }
        }
        // Normal repo: .git is a directory
        return File(dotGit, fileName)
    }
}
