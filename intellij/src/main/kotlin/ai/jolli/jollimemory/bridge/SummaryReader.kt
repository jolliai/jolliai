package ai.jolli.jollimemory.bridge

import ai.jolli.jollimemory.core.CommitSummary
import ai.jolli.jollimemory.core.JmLogger
import ai.jolli.jollimemory.core.StatusInfo
import com.google.gson.Gson
import com.google.gson.JsonParser

/**
 * Reads JolliMemory data from the filesystem and git — pure Kotlin, no Node.js.
 *
 * `worktreeDir` MUST be the CURRENT worktree root (project.basePath), not the
 * shared main-repo root. The CLI's `getStatus` treats its cwd as the target
 * checkout — it reads `.claude/settings.local.json`, `.gemini/settings.json`,
 * `.jolli/jollimemory/sessions.json`, and every source-detector from that
 * directory. Passing the main worktree root here would make every linked
 * worktree report the main checkout's hook state instead of its own, keep the
 * Claude Stop hook forever "installed" from the linked worktree's point of
 * view, and skip the startup self-heal that should repair it. Orphan-branch
 * reads (listSummaries / getSummary) go through `git` (GitOps), which resolves
 * the shared common-dir automatically, so they aren't affected by this choice.
 */
class SummaryReader(private val worktreeDir: String, private val git: GitOps) {

    private val log = JmLogger.create("SummaryReader")
    private val gson = Gson()

    /** Read the full installation and data status. */
    fun getStatus(@Suppress("UNUSED_PARAMETER") installer: HookInstaller): StatusInfo {
        val cliStatus = gson.fromJson(
            CliIntegrations.runIdeBridge(worktreeDir, "status"),
            StatusInfo::class.java,
        )
        return cliStatus.copy(
            nodeAvailable = CliIntegrations.isNodeAvailable(),
            integrationsActive = CliIntegrations.integrationsUpToDate(),
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

    /** Reads an archived plan body (`plans/<slug>.md`) from the orphan branch. */
    fun readPlanBody(slug: String): String? = git.readBranchFile(ORPHAN_BRANCH, "plans/$slug.md")

    /** Reads an archived markdown-note body (`notes/<id>.md`) from the orphan branch. */
    fun readNoteBody(id: String): String? = git.readBranchFile(ORPHAN_BRANCH, "notes/$id.md")

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

    /**
     * Renders a committed conversation (matched by [sessionId]) from the stored
     * transcript JSON into a read-only markdown transcript — used to display a
     * conversation whose original live file is gone. Returns null if not found.
     */
    fun renderCommittedConversationMarkdown(commitHash: String, sessionId: String, summary: CommitSummary? = null): String? {
        val resolved = summary ?: getSummary(commitHash)
        val ids = resolved?.transcripts
        val jsons = if (!ids.isNullOrEmpty()) {
            ids.map { git.readBranchFile(ORPHAN_BRANCH, "transcripts/$it.json") }
        } else {
            listOf(git.readBranchFile(ORPHAN_BRANCH, "transcripts/$commitHash.json"))
        }
        for (json in jsons) {
            val md = sessionToMarkdown(json, sessionId)
            if (md != null) return md
        }
        return null
    }

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH

        /** Renders the matching session's entries from a stored transcript JSON as markdown. */
        private fun sessionToMarkdown(json: String?, sessionId: String): String? {
            if (json.isNullOrBlank()) return null
            return try {
                val obj = JsonParser.parseString(json).asJsonObject
                val sessions = obj.getAsJsonArray("sessions") ?: return null
                val session = sessions.map { it.asJsonObject }.firstOrNull {
                    (it.get("sessionId")?.takeIf { e -> !e.isJsonNull }?.asString ?: "") == sessionId
                } ?: sessions.firstOrNull()?.asJsonObject ?: return null
                val entries = session.getAsJsonArray("entries") ?: return null
                val sb = StringBuilder()
                for (el in entries) {
                    val e = el.asJsonObject
                    val role = e.get("role")?.takeIf { !it.isJsonNull }?.asString ?: "?"
                    val content = e.get("content")?.takeIf { !it.isJsonNull }?.asString ?: ""
                    val who = when (role.lowercase()) {
                        "human", "user" -> "User"
                        "assistant" -> "Assistant"
                        else -> role.replaceFirstChar { it.uppercase() }
                    }
                    sb.append("### ").append(who).append("\n\n").append(content.trim()).append("\n\n---\n\n")
                }
                sb.toString().ifBlank { null }
            } catch (_: Exception) {
                null
            }
        }

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
    /** Per-segment conversation-token breakdown (canonical, TS-identical); null when not recorded. */
    val conversationTokenBreakdown: ai.jolli.jollimemory.core.ConversationTokenBreakdown? = null,
    /** Estimated USD cost of this memory's conversation tokens; null when unpriced/unrecorded. */
    val estimatedCostUsd: Double? = null,
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
    /**
     * Commit hash whose stored transcript actually holds this conversation. Null
     * means "the commit being displayed". It differs from the displayed hash only
     * for squashed memories whose transcripts live on a child commit, not the
     * squashed parent — without it, opening the stored transcript would look under
     * the parent hash (which has none) and fail. See [CommitsPanel.gatherConversations].
     */
    val sourceCommitHash: String? = null,
)
