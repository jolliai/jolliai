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
class SummaryReader(
    private val worktreeDir: String,
    private val git: GitOps,
    /**
     * Optional local Memory Bank reader. When present AND ready, every
     * summary/plan/note read tries the folder first (page-cache-fast) and
     * only falls back to the orphan branch (`git show`, 100-200 ms cold fork)
     * on a miss. When null, behaviour is unchanged: everything goes through
     * git plumbing.
     *
     * See [FolderStorageReader] for the lockstep contract with the CLI's
     * `FolderStorage.ts`. Attached via [attachFolder] once the KB folder
     * path is known (which itself costs an ide-bridge round-trip), so init
     * can create the reader before that resolve completes.
     */
    @Volatile private var folder: FolderStorageReader? = null,
) {

    private val log = JmLogger.create("SummaryReader")
    private val gson = Gson()

    /** Attach or detach the folder reader after construction. Safe to call
     *  from any thread; reads see the new value on the next lookup. */
    fun attachFolder(reader: FolderStorageReader?) { folder = reader }

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
            val json = git.readBranchFile(ORPHAN_BRANCH, path) ?: return@mapNotNull null
            parseSummaryBrief(json).also {
                // Unreadable file vs unparseable content: only the latter is worth a line.
                if (it == null) log.debug("Failed to parse summary %s", path)
            }
        }.sortedByDescending { it.date }
    }

    /** Get full summary object for a commit. */
    fun getSummary(commitHash: String): CommitSummary? {
        // Folder-first: on 0.99.0+ (dual-write default) this hits the OS page
        // cache in microseconds and avoids a `git show` fork entirely.
        folder?.getSummary(commitHash)?.let { return it }
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
        folder?.getSummaryJson(commitHash)?.let { return it }
        return git.readBranchFile(ORPHAN_BRANCH, "summaries/$commitHash.json")
    }

    /** Reads an archived plan body (`plans/<slug>.md`) from the orphan branch. */
    fun readPlanBody(slug: String): String? =
        folder?.readPlanBody(slug) ?: git.readBranchFile(ORPHAN_BRANCH, "plans/$slug.md")

    /** Reads an archived markdown-note body (`notes/<id>.md`) from the orphan branch. */
    fun readNoteBody(id: String): String? =
        folder?.readNoteBody(id) ?: git.readBranchFile(ORPHAN_BRANCH, "notes/$id.md")

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

        /**
         * Parses one stored `summaries/<hash>.json` body into a list row. Pure and
         * tolerant — returns null for null/blank/malformed input rather than throwing,
         * so one bad file never breaks the list.
         *
         * Every optional member goes through [notNull], which is load-bearing rather
         * than defensive: Gson hands back JsonNull — a non-null JsonElement — for an
         * explicit `"field": null`, so `obj.get(f)?.asInt` does NOT short-circuit and
         * the `asInt` throws. Caught here, that would drop the WHOLE summary, turning
         * one stray null field into a silently missing memory in the UI.
         */
        fun parseSummaryBrief(json: String?): CommitSummaryBrief? {
            if (json.isNullOrBlank()) return null
            return try {
                val obj = JsonParser.parseString(json).asJsonObject
                val commitHash = obj.notNull("commitHash")?.asString ?: ""
                CommitSummaryBrief(
                    hash = commitHash,
                    shortHash = commitHash.take(8),
                    message = obj.notNull("commitMessage")?.asString ?: "",
                    author = obj.notNull("commitAuthor")?.asString ?: "",
                    date = obj.notNull("commitDate")?.asString ?: "",
                    topicCount = obj.arrayOrNull("topics")?.size() ?: 0,
                    hasSummary = true,
                    // Keep parity with getBranchCommits so a future UI caller of
                    // listSummaries() still gets the clickable JM- chip.
                    jolliDocId = obj.notNull("jolliDocId")?.asInt,
                )
            } catch (_: Exception) {
                null
            }
        }

        /** Renders the matching session's entries from a stored transcript JSON as markdown. */
        private fun sessionToMarkdown(json: String?, sessionId: String): String? {
            if (json.isNullOrBlank()) return null
            return try {
                val obj = JsonParser.parseString(json).asJsonObject
                val sessions = obj.arrayOrNull("sessions") ?: return null
                val session = sessions.map { it.asJsonObject }.firstOrNull {
                    (it.notNull("sessionId")?.asString ?: "") == sessionId
                } ?: sessions.firstOrNull()?.asJsonObject ?: return null
                val entries = session.arrayOrNull("entries") ?: return null
                val sb = StringBuilder()
                for (el in entries) {
                    val e = el.asJsonObject
                    val role = e.notNull("role")?.asString ?: "?"
                    val content = e.notNull("content")?.asString ?: ""
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
                val sessions = obj.arrayOrNull("sessions") ?: return emptyList()
                sessions.mapNotNull { el ->
                    val session = el.asJsonObject
                    val source = session.notNull("source")?.asString ?: "ai"
                    val entries = session.arrayOrNull("entries")
                    val messageCount = entries?.size() ?: 0
                    ConversationBrief(
                        source = source,
                        title = deriveTitle(entries, source),
                        messageCount = messageCount,
                        sessionId = session.notNull("sessionId")?.asString ?: "",
                        transcriptPath = session.notNull("transcriptPath")?.asString,
                    )
                }
            } catch (_: Exception) {
                emptyList()
            }
        }

        private fun deriveTitle(entries: com.google.gson.JsonArray?, source: String): String {
            // Fall through human turns whose role or content is JSON null / blank — a single
            // null-content turn must not shadow the first turn that actually carries text.
            val firstLine = entries
                ?.asSequence()
                ?.map { it.asJsonObject }
                ?.filter {
                    val role = it.notNull("role")?.asString
                    role == "human" || role == "user"
                }
                ?.mapNotNull { it.notNull("content")?.asString }
                ?.mapNotNull { content -> content.lineSequence().firstOrNull { it.isNotBlank() }?.trim() }
                ?.firstOrNull { it.isNotEmpty() }
            if (firstLine.isNullOrEmpty()) return "${source.replaceFirstChar { it.uppercase() }} session"
            return if (firstLine.length > 60) firstLine.take(57) + "…" else firstLine
        }
    }
}

/**
 * Reads a member and returns null for BOTH "absent" and "present but JSON null".
 *
 * `JsonObject.get()` returns [com.google.gson.JsonNull] — a non-null JsonElement — for an
 * explicit `"field": null`, so `obj.get("f")?.asInt` does not short-circuit and the
 * `asInt` throws `UnsupportedOperationException`. Every accessor in this file sits inside
 * a catch-all that degrades to null / emptyList, so one stray JSON null would silently
 * drop an entire summary or conversation list rather than one field. Funnel optional
 * member reads through here.
 */
private fun com.google.gson.JsonObject.notNull(member: String): com.google.gson.JsonElement? =
    get(member)?.takeIf { !it.isJsonNull }

/**
 * Array counterpart of [notNull] — null for absent, JSON null, AND wrong type.
 *
 * Gson's own `getAsJsonArray(member)` is a bare cast (`(JsonArray) members.get(member)`), so
 * `"topics": null` throws ClassCastException rather than returning null. Caught by the
 * surrounding degrade-to-null handler, that would drop the whole record — the same failure
 * mode [notNull] exists to prevent, one type over.
 */
private fun com.google.gson.JsonObject.arrayOrNull(member: String): com.google.gson.JsonArray? =
    notNull(member)?.takeIf { it.isJsonArray }?.asJsonArray

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
    /**
     * Backend memory doc id used to render the `JM-<id>` reference prefix in the
     * Committed Memories panel. Null until the memory is synced to a Jolli Space;
     * the panel then falls back to `JM-<short hash>` so a reference is always shown.
     */
    val jolliDocId: Int? = null,
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
