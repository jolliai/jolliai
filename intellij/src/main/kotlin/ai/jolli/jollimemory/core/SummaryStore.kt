package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitOps
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
class SummaryStore(private val cwd: String, private val git: GitOps, private val storage: StorageProvider) {

    /** Backward-compatible constructor: creates OrphanBranchStorage from GitOps. */
    constructor(cwd: String, git: GitOps) : this(cwd, git, OrphanBranchStorage(git))

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

    fun storeSummary(summary: CommitSummary, force: Boolean = false, transcript: StoredTranscript? = null, planProgress: List<PlanProgressArtifact>? = null) {
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

        val files = mutableListOf(
            FileWrite("summaries/${summary.commitHash}.json", gson.toJson(summary)),
            FileWrite(INDEX_FILE, gson.toJson(newIndex)),
        )
        if (transcript != null && transcript.sessions.isNotEmpty()) {
            files.add(FileWrite("transcripts/${summary.commitHash}.json", gson.toJson(transcript)))
        }
        if (!planProgress.isNullOrEmpty()) {
            for (artifact in planProgress) {
                files.add(FileWrite("plan-progress/${artifact.planSlug}.json", gson.toJson(artifact)))
            }
        }

        storage.writeFiles(files, "Add summary for ${summary.commitHash.take(8)}: ${summary.commitMessage.take(50)}")
        log.info("Summary stored for commit %s", summary.commitHash.take(8))
    }

    fun migrateOneToOne(oldSummary: CommitSummary, newCommitInfo: CommitInfo) {
        val newSummary = CommitSummary(
            version = 3, commitHash = newCommitInfo.hash,
            commitMessage = newCommitInfo.message, commitAuthor = newCommitInfo.author,
            commitDate = newCommitInfo.date, branch = oldSummary.branch,
            generatedAt = Instant.now().toString(), commitType = CommitType.rebase,
            jolliDocId = oldSummary.jolliDocId, jolliDocUrl = oldSummary.jolliDocUrl,
            plans = oldSummary.plans, e2eTestGuide = oldSummary.e2eTestGuide,
            children = listOf(oldSummary.copy(jolliDocId = null, jolliDocUrl = null, plans = null, e2eTestGuide = null)),
        )
        storeSummary(newSummary, force = true)
    }

    fun mergeManyToOne(oldSummaries: List<CommitSummary>, newCommitInfo: CommitInfo) {
        val children = oldSummaries.sortedByDescending { it.commitDate }
            .map { it.copy(jolliDocId = null, jolliDocUrl = null, plans = null, e2eTestGuide = null) }
        val allPlans = oldSummaries.flatMap { it.plans ?: emptyList() }
            .groupBy { it.slug }.mapNotNull { (_, p) -> p.maxByOrNull { it.updatedAt } }
        val allE2e = oldSummaries.flatMap { it.e2eTestGuide ?: emptyList() }

        val newSummary = CommitSummary(
            version = 3, commitHash = newCommitInfo.hash,
            commitMessage = newCommitInfo.message, commitAuthor = newCommitInfo.author,
            commitDate = newCommitInfo.date, branch = oldSummaries.firstOrNull()?.branch ?: "unknown",
            generatedAt = Instant.now().toString(), commitType = CommitType.squash,
            plans = allPlans.takeIf { it.isNotEmpty() }, e2eTestGuide = allE2e.takeIf { it.isNotEmpty() },
            children = children,
        )
        storeSummary(newSummary, force = true)
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

    /** Reads a plan file from storage. */
    fun readPlanFromBranch(slug: String): String? {
        return storage.readFile("plans/$slug.md")
    }

    /** Writes a plan file to storage. */
    fun writePlanToBranch(slug: String, content: String, message: String) {
        val files = listOf(FileWrite("plans/$slug.md", content))
        storage.writeFiles(files, message)
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
