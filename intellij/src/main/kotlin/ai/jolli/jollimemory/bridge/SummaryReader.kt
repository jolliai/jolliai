package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CodexSessionDiscoverer
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.GeminiSupport
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.SessionTracker
import ai.jolli.jollimemory.core.StatusInfo
import com.google.gson.Gson
import com.google.gson.JsonParser

/**
 * Reads JolliMemory data from the filesystem and git — pure Kotlin, no Node.js.
 */
class SummaryReader(private val projectDir: String, private val git: GitOps) {

    private val log = JmLogger.create("SummaryReader")
    private val gson = Gson()

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH
    }

    /** Read the full installation and data status. */
    fun getStatus(installer: HookInstaller): StatusInfo {
        val hooksInstalled = installer.areAllHooksInstalled()
        val sessions = SessionTracker.loadAllSessions(projectDir)
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        val branchExists = git.branchExists(ORPHAN_BRANCH)
        val summaryCount = if (branchExists) countSummaries() else 0

        return StatusInfo(
            enabled = hooksInstalled,
            claudeHookInstalled = installer.isClaudeHookInstalled(),
            gitHookInstalled = installer.isGitHookInstalled("post-commit",
                "# >>> JolliMemory post-commit hook >>>"),
            geminiHookInstalled = installer.isGeminiHookInstalled(),
            activeSessions = sessions.size,
            mostRecentSession = SessionTracker.loadMostRecentSession(projectDir),
            summaryCount = summaryCount,
            orphanBranch = ORPHAN_BRANCH,
            claudeDetected = installer.isClaudeDetected(),
            codexDetected = CodexSessionDiscoverer.isCodexInstalled(),
            codexEnabled = config.codexEnabled,
            geminiDetected = GeminiSupport.isGeminiInstalled(),
            geminiEnabled = config.geminiEnabled,
        )
    }

    private fun countSummaries(): Int {
        return git.listBranchFiles(ORPHAN_BRANCH, "summaries/").size
    }

    /** List commit summaries on the orphan branch. */
    fun listSummaries(): List<CommitSummaryBrief> {
        val files = git.listBranchFiles(ORPHAN_BRANCH, "summaries/")
        return files.mapNotNull { path ->
            try {
                val json = git.readBranchFile(ORPHAN_BRANCH, path) ?: return@mapNotNull null
                val obj = JsonParser.parseString(json).asJsonObject
                CommitSummaryBrief(
                    hash = obj.get("commitHash")?.asString ?: "",
                    shortHash = (obj.get("commitHash")?.asString ?: "").take(8),
                    message = obj.get("commitMessage")?.asString ?: "",
                    author = obj.get("commitAuthor")?.asString ?: "",
                    date = obj.get("commitDate")?.asString ?: "",
                    topicCount = obj.getAsJsonArray("topics")?.size() ?: 0,
                    hasSummary = true,
                )
            } catch (e: Exception) {
                log.debug("Failed to parse summary %s: %s", path, e.message)
                null
            }
        }.sortedByDescending { it.date }
    }

    /** Get full summary object for a commit. */
    fun getSummary(commitHash: String): CommitSummary? {
        val path = "summaries/$commitHash.json"
        val json = git.readBranchFile(ORPHAN_BRANCH, path) ?: return null
        return try {
            gson.fromJson(json, CommitSummary::class.java)
        } catch (e: Exception) {
            log.error("Failed to parse summary for %s: %s", commitHash, e.message)
            null
        }
    }

    /** Get raw JSON for a commit summary. */
    fun getSummaryJson(commitHash: String): String? {
        return git.readBranchFile(ORPHAN_BRANCH, "summaries/$commitHash.json")
    }
}

/** Lightweight commit info for list display — matches VS Code BranchCommit. */
data class CommitSummaryBrief(
    val hash: String,
    val shortHash: String,
    val message: String,
    val author: String,
    val authorEmail: String = "",
    val date: String,
    val shortDate: String = "",
    val topicCount: Int = 0,
    val insertions: Int = 0,
    val deletions: Int = 0,
    val filesChanged: Int = 0,
    val isPushed: Boolean = false,
    val hasSummary: Boolean = false,
    val commitType: String? = null,
)
