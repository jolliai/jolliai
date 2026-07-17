package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitCommands
import ai.jolli.jollimemory.core.references.ReferenceStore
import ai.jolli.jollimemory.core.references.SourceId
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.time.Instant

/**
 * SummaryStore — Kotlin port of SummaryStore.ts
 *
 * Stores and retrieves commit summaries via a StorageProvider.
 * The default provider is OrphanBranchStorage (git plumbing on an orphan branch).
 *
 * GitOps is still needed for non-storage git operations (e.g. cat-file
 * for tree hash extraction).
 */
class SummaryStore(private val cwd: String, private val git: GitCommands, private val storage: StorageProvider) {

    /** Backward-compatible constructor: creates OrphanBranchStorage from GitCommands. */
    constructor(cwd: String, git: GitCommands) : this(cwd, git, OrphanBranchStorage(git))

    private val log = JmLogger.create("SummaryStore")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH
        private const val INDEX_FILE = "index.json"
    }

    // ── Read API ────────────────────────────────────────────────────────────

    fun loadIndex(): SummaryIndex? {
        val json = storage.readFile(INDEX_FILE) ?: return null
        return try {
            gson.fromJson(json, SummaryIndex::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse index: %s", e.message)
            null
        }
    }

    fun getSummary(commitHash: String): CommitSummary? {
        val resolved = resolveAlias(commitHash)
        val json = storage.readFile("summaries/$resolved.json") ?: return null
        return try {
            gson.fromJson(json, CommitSummary::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse summary for %s: %s", commitHash.take(8), e.message)
            null
        }
    }

    fun listSummaries(count: Int = 10): List<CommitSummary> {
        val index = loadIndex() ?: return emptyList()
        return index.entries
            .filter { it.parentCommitHash == null }
            .sortedByDescending { it.commitDate }
            .take(count)
            .mapNotNull { getSummary(it.commitHash) }
    }

    fun getSummaryCount(): Int = storage.listFiles("summaries/").size

    fun findRootHash(commitHash: String): String? {
        val index = loadIndex() ?: return null
        val entryMap = index.entries.associateBy { it.commitHash }
        val resolved = index.commitAliases?.get(commitHash) ?: commitHash
        var current = entryMap[resolved] ?: return null
        while (current.parentCommitHash != null) {
            current = entryMap[current.parentCommitHash] ?: return current.commitHash
        }
        return current.commitHash
    }

    fun filterCommitsWithSummary(hashes: List<String>): Set<String> {
        val index = loadIndex() ?: return emptySet()
        val indexed = index.entries.map { it.commitHash }.toSet()
        val aliases = index.commitAliases ?: emptyMap()

        val matched = mutableSetOf<String>()
        for (hash in hashes) {
            if (hash in indexed || hash in aliases) {
                matched.add(hash)
            }
        }
        return matched
    }

    /**
     * Scans unmatched commit hashes for tree-hash aliases.
     * When a commit's tree hash matches an indexed summary's tree hash,
     * records the alias so future lookups find the summary.
     * This enables cross-branch matching (e.g. GitHub squash merge vs feature branch).
     */
    fun scanTreeHashAliases(unmatchedHashes: List<String>): Boolean {
        if (unmatchedHashes.isEmpty()) return false

        val index = loadIndex() ?: return false
        val treeHashToCommit = mutableMapOf<String, String>()
        for (entry in index.entries) {
            val th = entry.treeHash
            if (th != null) treeHashToCommit[th] = entry.commitHash
        }
        if (treeHashToCommit.isEmpty()) return false

        val existingAliases = (index.commitAliases ?: emptyMap()).toMutableMap()
        var anyFound = false

        for (hash in unmatchedHashes) {
            if (hash in existingAliases) continue
            // Get the tree hash for this commit (reads from the actual git repo, not storage)
            val catFile = git.exec("cat-file", "-p", hash) ?: continue
            val match = Regex("^tree ([a-f0-9]+)").find(catFile) ?: continue
            val treeHash = match.groupValues[1]

            val aliasTarget = treeHashToCommit[treeHash]
            if (aliasTarget != null && aliasTarget != hash) {
                existingAliases[hash] = aliasTarget
                anyFound = true
                log.info("Tree hash alias: %s → %s", hash.take(8), aliasTarget.take(8))
            }
        }

        if (anyFound) {
            val updated = index.copy(commitAliases = existingAliases)
            val files = listOf(FileWrite("index.json", gson.toJson(updated)))
            storage.writeFiles(files, "Update commit aliases")
        }

        return anyFound
    }

    /** Resolves a commit hash through aliases. Returns the alias target or the original hash. */
    fun resolveAlias(hash: String): String {
        val index = loadIndex() ?: return hash
        return index.commitAliases?.get(hash) ?: hash
    }

    // ── Write API ───────────────────────────────────────────────────────────

    fun storeSummary(summary: CommitSummary, force: Boolean = false, transcript: StoredTranscript? = null, planProgress: List<PlanProgressArtifact>? = null, referenceFiles: List<FileWrite>? = null) {
        val existingIndex = loadIndex()
        val entryMap = (existingIndex?.entries ?: emptyList()).associateBy { it.commitHash }.toMutableMap()

        if (!force && summary.commitHash in entryMap) {
            log.info("Summary for %s already exists — skipping", summary.commitHash.take(8))
            return
        }

        val newEntries = flattenSummaryTree(summary, null)
        for (entry in newEntries) entryMap[entry.commitHash] = entry

        val newIndex = SummaryIndex(
            version = 3,
            entries = entryMap.values.toList(),
            commitAliases = existingIndex?.commitAliases,
        )

        val indexJson = gson.toJson(newIndex)

        val files = mutableListOf(
            FileWrite("summaries/${summary.commitHash}.json", gson.toJson(summary)),
            FileWrite(INDEX_FILE, indexJson),
        )
        if (transcript != null && transcript.sessions.isNotEmpty()) {
            files.add(FileWrite("transcripts/${summary.commitHash}.json", gson.toJson(transcript)))
        }
        if (!planProgress.isNullOrEmpty()) {
            for (artifact in planProgress) {
                files.add(FileWrite("plan-progress/${artifact.planSlug}.json", gson.toJson(artifact)))
            }
        }
        if (!referenceFiles.isNullOrEmpty()) {
            files.addAll(referenceFiles)
        }

        storage.writeFiles(files, "Add summary for ${summary.commitHash.take(8)}: ${summary.commitMessage.take(50)}")
    }

    fun migrateOneToOne(oldSummary: CommitSummary, newCommitInfo: CommitInfo) {
        val newSummary = CommitSummary(
            version = SummaryTree.CURRENT_SCHEMA_VERSION, commitHash = newCommitInfo.hash,
            commitMessage = newCommitInfo.message, commitAuthor = newCommitInfo.author,
            commitDate = newCommitInfo.date, branch = oldSummary.branch,
            generatedAt = Instant.now().toString(), commitType = CommitType.rebase,
            jolliDocId = oldSummary.jolliDocId, jolliDocUrl = oldSummary.jolliDocUrl,
            orphanedDocIds = oldSummary.orphanedDocIds,
            unresolvedOrphanHashes = oldSummary.unresolvedOrphanHashes,
            plans = oldSummary.plans, e2eTestGuide = oldSummary.e2eTestGuide, recap = oldSummary.recap,
            children = listOf(stripMergedMetadata(oldSummary)),
        )
        storeSummary(newSummary, force = true)
    }

    fun mergeManyToOne(
        oldSummaries: List<CommitSummary>,
        newCommitInfo: CommitInfo,
        apiKey: String? = null,
        model: String? = null,
        jolliApiKey: String? = null,
        aiProvider: String? = null,
    ) {
        val children = oldSummaries.sortedByDescending { it.commitDate }
            .map(::stripMergedMetadata)
        val allPlans = oldSummaries.flatMap { it.plans ?: emptyList() }
            .groupBy { it.slug }.mapNotNull { (_, p) -> p.maxByOrNull { it.updatedAt } }
        val allE2e = oldSummaries.flatMap { it.e2eTestGuide ?: emptyList() }
        val jolliCandidates = collectJolliCandidates(oldSummaries)
        val jolliWinner = jolliCandidates.maxWithOrNull(
            compareBy<JolliCandidate> { it.generatedAt }.thenBy { it.commitDate },
        )
        val orphanedDocIds = (
            jolliCandidates.filter { it !== jolliWinner }.map { it.docId } +
                collectOrphanedDocIds(oldSummaries)
            ).distinct().filter { it != jolliWinner?.docId }
        val unresolvedOrphanHashes = (
            oldSummaries.filter { it.jolliDocId == null }.map { it.commitHash } +
                collectUnresolvedOrphanHashes(oldSummaries)
            ).distinct()

        // Build consolidation sources from old summaries
        val sources = oldSummaries.map { s ->
            Summarizer.SquashConsolidationSource(
                commitHash = s.commitHash,
                commitDate = s.commitDate,
                commitMessage = s.commitMessage,
                ticketId = s.ticketId,
                recap = s.recap,
                topics = s.topics ?: emptyList(),
            )
        }

        // Try LLM consolidation, fall back to mechanical merge
        var mergedTopics: List<TopicSummary>? = null
        var mergedRecap: String? = null
        var mergedTicketId: String? = null
        var llmMetadata: LlmCallMetadata? = null
        var summaryError: String? = null

        val hasCredentials = !apiKey.isNullOrBlank() || !jolliApiKey.isNullOrBlank()
        if (hasCredentials) {
            val outcome = Summarizer.generateSquashConsolidation(
                sources = sources,
                squashCommitMessage = newCommitInfo.message,
                apiKey = apiKey,
                model = model,
                jolliApiKey = jolliApiKey,
                aiProvider = aiProvider,
            )
            when (outcome) {
                is Summarizer.SquashConsolidationOutcome.Ok -> {
                    mergedTopics = outcome.result.topics
                    mergedRecap = outcome.result.recap
                    mergedTicketId = outcome.result.ticketId
                    llmMetadata = outcome.result.llm
                }
                is Summarizer.SquashConsolidationOutcome.NoContent -> {
                    val (topics, recap, ticket) = Summarizer.mechanicalConsolidate(sources)
                    mergedTopics = topics
                    mergedRecap = recap
                    mergedTicketId = ticket
                }
                is Summarizer.SquashConsolidationOutcome.LlmError -> {
                    val (topics, recap, ticket) = Summarizer.mechanicalConsolidate(sources)
                    mergedTopics = topics
                    mergedRecap = recap
                    mergedTicketId = ticket
                    summaryError = "llm-failed"
                }
            }
        } else {
            val (topics, recap, ticket) = Summarizer.mechanicalConsolidate(sources)
            mergedTopics = topics
            mergedRecap = recap
            mergedTicketId = ticket
        }

        // Merge the squashed commits' stored transcripts into one keyed under the
        // new commit. Each pre-squash commit stored only the *new* entries for a
        // session, so we group by session and concatenate those slices in
        // chronological (oldest-first) order to reconstruct the full conversation.
        // Without this the transcripts stay orphaned under the old hashes and the
        // panel (which reads transcripts/<commitHash>.json) shows no conversations.
        val mergedSessions = LinkedHashMap<String, StoredSession>()
        for (s in oldSummaries.sortedBy { it.commitDate }) {
            val tjson = storage.readFile("transcripts/${s.commitHash}.json") ?: continue
            val t = try { gson.fromJson(tjson, StoredTranscript::class.java) } catch (_: Exception) { null } ?: continue
            for (session in t.sessions) {
                val key = session.sessionId.ifBlank { "${session.source}|${session.transcriptPath}" }
                val existing = mergedSessions[key]
                mergedSessions[key] =
                    if (existing == null) session else existing.copy(
                        entries = existing.entries + session.entries,
                        transcriptPath = existing.transcriptPath ?: session.transcriptPath,
                    )
            }
        }
        val mergedTranscript = mergedSessions.values.toList()
            .takeIf { it.isNotEmpty() }?.let { StoredTranscript(it) }
        val totalEntries = mergedSessions.values.sumOf { it.entries.size }
        val totalTurns = mergedSessions.values.sumOf { s -> s.entries.count { it.role == "human" } }
        // Canonical (TS-identical) conversation usage: token breakdown + per-model cost.
        val usage = mergedTranscript?.let { ConversationUsage.aggregate(it.sessions) }

        val newSummary = CommitSummary(
            version = SummaryTree.CURRENT_SCHEMA_VERSION, commitHash = newCommitInfo.hash,
            commitMessage = newCommitInfo.message, commitAuthor = newCommitInfo.author,
            commitDate = newCommitInfo.date, branch = oldSummaries.firstOrNull()?.branch ?: "unknown",
            generatedAt = Instant.now().toString(), commitType = CommitType.squash,
            plans = allPlans.takeIf { it.isNotEmpty() }, e2eTestGuide = allE2e.takeIf { it.isNotEmpty() },
            jolliDocId = jolliWinner?.docId,
            jolliDocUrl = jolliWinner?.docUrl,
            orphanedDocIds = orphanedDocIds.takeIf { it.isNotEmpty() },
            unresolvedOrphanHashes = unresolvedOrphanHashes.takeIf { it.isNotEmpty() },
            topics = mergedTopics?.takeIf { it.isNotEmpty() },
            recap = mergedRecap,
            ticketId = mergedTicketId,
            llm = llmMetadata,
            conversationTurns = totalTurns.takeIf { it > 0 },
            transcriptEntries = totalEntries.takeIf { it > 0 },
            conversationTokens = usage?.conversationTokens,
            conversationTokenBreakdown = usage?.breakdown,
            conversationModels = usage?.models?.takeIf { it.isNotEmpty() },
            estimatedCostUsd = usage?.estimatedCostUsd,
            pricesAsOf = usage?.estimatedCostUsd?.let { ModelPricing.PRICES_AS_OF },
            summaryError = summaryError,
            children = children,
        )
        storeSummary(newSummary, force = true, transcript = mergedTranscript)
    }

    // ── Plan progress storage ─────────────────────────────────────────────

    /** Reads a plan progress artifact from storage. */
    fun readPlanProgress(slug: String): PlanProgressArtifact? {
        val json = storage.readFile("plan-progress/$slug.json") ?: return null
        return try {
            gson.fromJson(json, PlanProgressArtifact::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse plan progress for %s: %s", slug, e.message)
            null
        }
    }

    // ── Plan storage ─────────────────────────────────────────────────────

    /** Writes plan files to storage in a single atomic commit. */
    fun storePlanFiles(files: List<FileWrite>, commitMessage: String) {
        if (files.isEmpty()) return
        storage.writeFiles(files, commitMessage)
        log.info("Stored %d plan file(s): %s", files.size, commitMessage)
    }

    /** Batch write note files (`notes/<id>.md`) to storage — dual-writes like plans. */
    fun storeNoteFiles(files: List<FileWrite>, commitMessage: String) {
        if (files.isEmpty()) return
        storage.writeFiles(files, commitMessage)
        log.info("Stored %d note file(s): %s", files.size, commitMessage)
    }

    /** Reads a plan file from storage. */
    fun readPlanFromBranch(slug: String): String? {
        return storage.readFile("plans/$slug.md")
    }

    /** Writes a plan file to storage. */
    fun writePlanToBranch(slug: String, content: String, message: String) {
        val files = listOf(FileWrite("plans/$slug.md", content))
        storage.writeFiles(files, message)
    }

    // ── Reference storage (orphan branch) ────────────────────────────────

    /**
     * Build the orphan-branch path for a reference markdown file.
     * Port of CLI's `orphanPathFor(source, archivedKey)`.
     */
    private fun orphanPathFor(source: SourceId, archivedKey: String): String {
        val prefix = "${source.name}:"
        val bareKey = if (archivedKey.startsWith(prefix)) archivedKey.removePrefix(prefix) else archivedKey
        val sanitized = ReferenceStore.sanitizeNativeIdForPath(source, bareKey)
        return "references/${source.name}/$sanitized.md"
    }

    /** Reads a reference's archived markdown from the orphan branch. */
    fun readReferenceFromBranch(source: SourceId, archivedKey: String): String? {
        return try {
            storage.readFile(orphanPathFor(source, archivedKey))
        } catch (_: Exception) {
            null
        }
    }

    /** Writes a single reference markdown file to the orphan branch. */
    fun writeReferenceFromBranch(source: SourceId, archivedKey: String, content: String, message: String) {
        val files = listOf(FileWrite(orphanPathFor(source, archivedKey), content))
        storage.writeFiles(files, message)
    }

    /** Batch write reference files to the orphan branch. */
    fun storeReferences(files: List<FileWrite>, commitMessage: String) {
        if (files.isEmpty()) return
        storage.writeFiles(files, commitMessage)
        log.info("Stored %d reference file(s)", files.size)
    }

    // ── Transcript storage ──────────────────────────────────────────────

    /** Lists commit hashes that have transcript files in storage. */
    fun getTranscriptHashes(): Set<String> {
        return storage.listFiles("transcripts/")
            .map { it.removePrefix("transcripts/").removeSuffix(".json") }
            .toSet()
    }

    /** Reads a stored transcript for a commit hash. */
    fun readTranscript(commitHash: String): StoredTranscript? {
        val json = storage.readFile("transcripts/$commitHash.json") ?: return null
        return try {
            gson.fromJson(json, StoredTranscript::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse transcript for %s: %s", commitHash.take(8), e.message)
            null
        }
    }

    /** Batch writes and deletes transcript files. */
    fun writeTranscriptBatch(writes: Map<String, StoredTranscript>, deletes: Set<String>) {
        val files = mutableListOf<FileWrite>()
        for ((hash, transcript) in writes) {
            files.add(FileWrite("transcripts/$hash.json", gson.toJson(transcript)))
        }
        for (hash in deletes) {
            files.add(FileWrite("transcripts/$hash.json", "", delete = true))
        }
        if (files.isNotEmpty()) {
            storage.writeFiles(files, "Update transcripts")
        }
    }

    // ── Internal helpers ────────────────────────────────────────────────────

    private data class JolliCandidate(
        val docId: Int,
        val docUrl: String,
        val commitDate: String,
        val generatedAt: String,
    )

    private fun collectJolliCandidates(nodes: List<CommitSummary>): List<JolliCandidate> = nodes.flatMap { node ->
        val own = if (node.jolliDocId != null && node.jolliDocUrl != null) {
            listOf(JolliCandidate(node.jolliDocId, node.jolliDocUrl, node.commitDate, node.generatedAt))
        } else {
            emptyList()
        }
        own + collectJolliCandidates(node.children ?: emptyList())
    }

    private fun collectOrphanedDocIds(nodes: List<CommitSummary>): List<Int> = nodes.flatMap { node ->
        (node.orphanedDocIds ?: emptyList()) + collectOrphanedDocIds(node.children ?: emptyList())
    }

    private fun collectUnresolvedOrphanHashes(nodes: List<CommitSummary>): List<String> = nodes.flatMap { node ->
        (node.unresolvedOrphanHashes ?: emptyList()) + collectUnresolvedOrphanHashes(node.children ?: emptyList())
    }

    private fun stripMergedMetadata(node: CommitSummary): CommitSummary = node.copy(
        jolliDocId = null,
        jolliDocUrl = null,
        orphanedDocIds = null,
        unresolvedOrphanHashes = null,
        plans = null,
        e2eTestGuide = null,
        recap = null,
        children = node.children?.map(::stripMergedMetadata),
    )

    private fun flattenSummaryTree(node: CommitSummary, parentHash: String?): List<SummaryIndexEntry> {
        val treeHash = git.exec("cat-file", "-p", node.commitHash)?.let { output ->
            Regex("^tree (\\w+)").find(output)?.groupValues?.get(1)
        }
        val entry = SummaryIndexEntry(
            commitHash = node.commitHash, parentCommitHash = parentHash,
            treeHash = treeHash, commitType = node.commitType,
            commitMessage = node.commitMessage, commitDate = node.commitDate,
            branch = node.branch, generatedAt = node.generatedAt,
        )
        return listOf(entry) + (node.children ?: emptyList()).flatMap { flattenSummaryTree(it, node.commitHash) }
    }
}
