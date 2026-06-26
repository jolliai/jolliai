package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CodexSessionDiscoverer
import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.CopilotChatSupport
import ai.jolli.jollimemory.core.CopilotSupport
import ai.jolli.jollimemory.core.CursorSupport
import ai.jolli.jollimemory.core.GeminiSupport
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.OpenCodeSupport
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

    /** Read the full installation and data status. */
    fun getStatus(installer: HookInstaller): StatusInfo {
        val hooksInstalled = installer.areAllHooksInstalled()
        val sessions = SessionTracker.loadAllSessions(projectDir)
        val config = SessionTracker.loadConfigFromDir(SessionTracker.getGlobalConfigDir())
        val branchExists = git.branchExists(ORPHAN_BRANCH)
        val summaryCount = if (branchExists) countSummaries() else 0

        // Lightweight DB health checks — no full scan, just open + trivial query
        val openCodeInstalled = OpenCodeSupport.isOpenCodeInstalled()
        val openCodeError = if (openCodeInstalled && config.openCodeEnabled != false)
            OpenCodeSupport.checkDbHealth() else null

        val cursorInstalled = CursorSupport.isCursorInstalled()
        val cursorError = if (cursorInstalled && config.cursorEnabled != false)
            CursorSupport.checkDbHealth() else null

        val copilotInstalled = CopilotSupport.isCopilotInstalled()
        val copilotError = if (copilotInstalled && config.copilotEnabled != false)
            CopilotSupport.checkDbHealth() else null

        val copilotChatInstalled = CopilotChatSupport.isCopilotChatInstalled()

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
            openCodeDetected = openCodeInstalled,
            openCodeEnabled = config.openCodeEnabled,
            openCodeScanError = openCodeError,
            cursorDetected = cursorInstalled,
            cursorEnabled = config.cursorEnabled,
            cursorScanError = cursorError,
            copilotDetected = copilotInstalled,
            copilotEnabled = config.copilotEnabled,
            copilotScanError = copilotError,
            copilotChatDetected = copilotChatInstalled,
            copilotChatScanError = null,
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

    /**
     * Reads the committed AI conversations for a commit. Looks up the
     * summary's `transcripts` array for the real transcript IDs (UUIDs in v5,
     * commit hashes in legacy data), then reads each transcript file and
     * aggregates all sessions. Falls back to `transcripts/{commitHash}.json`
     * for pre-v5 data that has no summary or no `transcripts` field.
     */
    fun getCommittedConversations(commitHash: String, summary: CommitSummary? = null): List<ConversationBrief> {
        val resolved = summary ?: getSummary(commitHash)
        val ids = resolved?.transcripts
        if (!ids.isNullOrEmpty()) {
            return ids.flatMap { id ->
                val json = git.readBranchFile(ORPHAN_BRANCH, "transcripts/$id.json")
                parseConversations(json)
            }
        }
        // Legacy fallback: transcript file named by commit hash.
        val json = git.readBranchFile(ORPHAN_BRANCH, "transcripts/$commitHash.json")
        return parseConversations(json)
    }

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH

        /**
         * Parses a stored `transcripts/<hash>.json` body (a [StoredTranscript]:
         * `{ sessions: [...] }`) into lightweight conversation rows. Pure and
         * tolerant — returns an empty list for null/blank/malformed input rather
         * than throwing, so a single bad transcript never breaks the panel.
         *
         * The stored shape has no human-facing title, so one is derived from the
         * first human turn's opening line (truncated); failing that, the source
         * name is used.
         */
        fun parseConversations(json: String?): List<ConversationBrief> {
            if (json.isNullOrBlank()) return emptyList()
            return try {
                val obj = JsonParser.parseString(json).asJsonObject
                val sessions = obj.getAsJsonArray("sessions") ?: return emptyList()
                sessions.mapNotNull { el ->
                    val session = el.asJsonObject
                    val source = session.get("source")?.takeIf { !it.isJsonNull }?.asString ?: "ai"
                    val entries = session.getAsJsonArray("entries")
                    val messageCount = entries?.size() ?: 0
                    ConversationBrief(
                        source = source,
                        title = deriveTitle(entries, source),
                        messageCount = messageCount,
                        sessionId = session.get("sessionId")?.takeIf { !it.isJsonNull }?.asString ?: "",
                        transcriptPath = session.get("transcriptPath")?.takeIf { !it.isJsonNull }?.asString,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        private fun deriveTitle(entries: com.google.gson.JsonArray?, source: String): String {
            val firstHuman = entries?.firstOrNull { el ->
                val role = el.asJsonObject.get("role")?.asString
                role == "human" || role == "user"
            }?.asJsonObject?.get("content")?.asString
            val firstLine = firstHuman?.lineSequence()?.firstOrNull { it.isNotBlank() }?.trim()
            if (firstLine.isNullOrEmpty()) return "${source.replaceFirstChar { it.uppercase() }} session"
            return if (firstLine.length > 60) firstLine.take(57) + "…" else firstLine
        }
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
    // ── Memory-detail enrichment (populated from the commit's CommitSummary in
    //    JolliMemoryService.getBranchCommits; absent for code-only commits) ──
    /** Coding-session token usage captured by this memory; null when not recorded. */
    val tokenUsage: ai.jolli.jollimemory.core.TokenUsage? = null,
    /** Whether this memory carries an E2E test guide, and how many scenarios. */
    val e2eScenarioCount: Int = 0,
    /** Whether this memory has been pushed to Jolli Space (article exists). */
    val isSyncedToJolli: Boolean = false,
    /** Direct URL to the Jolli Space article, when synced. */
    val jolliDocUrl: String? = null,
    /** Count of human turns across the contributing conversations. */
    val conversationTurns: Int? = null,
    /** Count of linked context items (plans + notes + references). */
    val contextCount: Int = 0,
) {
    val hasE2eGuide: Boolean get() = e2eScenarioCount > 0
}

/** A single committed conversation, distilled for the panel's CONVERSATIONS group. */
data class ConversationBrief(
    val source: String,
    val title: String,
    val messageCount: Int,
    /** Session id from the stored transcript — used to open the conversation. */
    val sessionId: String = "",
    /** Original transcript path on disk; null when not recorded. */
    val transcriptPath: String? = null,
)
