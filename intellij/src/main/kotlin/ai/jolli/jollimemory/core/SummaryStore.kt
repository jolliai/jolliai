package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitOps
import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.time.Instant

/**
 * SummaryStore — Kotlin port of SummaryStore.ts
 *
 * Stores and retrieves commit summaries from the orphan branch
 * using git plumbing commands (hash-object, mktree, commit-tree, update-ref).
 * Never checks out the orphan branch.
 */
class SummaryStore(private val cwd: String, private val git: GitOps) {

    private val log = JmLogger.create("SummaryStore")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH
        private const val INDEX_FILE = "index.json"
    }

    // ── Read API ────────────────────────────────────────────────────────────

    fun loadIndex(): SummaryIndex? {
        val json = git.readBranchFile(ORPHAN_BRANCH, INDEX_FILE) ?: return null
        return try {
            gson.fromJson(json, SummaryIndex::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse index: %s", e.message)
            null
        }
    }

    fun getSummary(commitHash: String): CommitSummary? {
        val json = git.readBranchFile(ORPHAN_BRANCH, "summaries/$commitHash.json") ?: return null
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

    fun getSummaryCount(): Int = git.listBranchFiles(ORPHAN_BRANCH, "summaries/").size

    fun findRootHash(commitHash: String): String? {
        val index = loadIndex() ?: return null
        val entryMap = index.entries.associateBy { it.commitHash }
        var current = entryMap[commitHash] ?: return null
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
            // Get the tree hash for this commit
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
            // Update the index with new aliases
            val updated = index.copy(commitAliases = existingAliases)
            val files = listOf(FileWrite("index.json", gson.toJson(updated)))
            writeFilesToBranch(files, "Update commit aliases")
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

        writeFilesToBranch(files, "Add summary for ${summary.commitHash.take(8)}: ${summary.commitMessage.take(50)}")
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

    /** Reads a plan progress artifact from the orphan branch. */
    fun readPlanProgress(slug: String): PlanProgressArtifact? {
        val json = git.readBranchFile(ORPHAN_BRANCH, "plan-progress/$slug.json") ?: return null
        return try {
            gson.fromJson(json, PlanProgressArtifact::class.java)
        } catch (e: Exception) {
            log.warn("Failed to parse plan progress for %s: %s", slug, e.message)
            null
        }
    }

    // ── Plan storage ─────────────────────────────────────────────────────

    /** Writes plan files to the orphan branch in a single atomic commit. */
    fun storePlanFiles(files: List<FileWrite>, commitMessage: String) {
        if (files.isEmpty()) return
        writeFilesToBranch(files, commitMessage)
        log.info("Stored %d plan file(s): %s", files.size, commitMessage)
    }

    /** Reads a plan file from the orphan branch. */
    fun readPlanFromBranch(slug: String): String? {
        return git.readBranchFile(ORPHAN_BRANCH, "plans/$slug.md")
    }

    /** Writes a plan file to the orphan branch. */
    fun writePlanToBranch(slug: String, content: String, message: String) {
        val files = listOf(FileWrite("plans/$slug.md", content))
        writeFilesToBranch(files, message)
    }

    // ── Transcript storage ──────────────────────────────────────────────

    /** Lists commit hashes that have transcript files on the orphan branch. */
    fun getTranscriptHashes(): Set<String> {
        return git.listBranchFiles(ORPHAN_BRANCH, "transcripts/")
            .map { it.removePrefix("transcripts/").removeSuffix(".json") }
            .toSet()
    }

    /** Reads a stored transcript for a commit hash. */
    fun readTranscript(commitHash: String): StoredTranscript? {
        val json = git.readBranchFile(ORPHAN_BRANCH, "transcripts/$commitHash.json") ?: return null
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
            writeFilesToBranch(files, "Update transcripts")
        }
    }

    // ── Git plumbing (matches Node.js GitOps.ts) ────────────────────────────

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

    /** Ensures the orphan branch exists using pure plumbing (no checkout). */
    private fun ensureOrphanBranch() {
        if (git.branchExists(ORPHAN_BRANCH)) return

        log.info("Creating orphan branch '%s' using plumbing commands", ORPHAN_BRANCH)

        // Step 1: Write initial index.json as a blob
        val initialIndex = gson.toJson(SummaryIndex(version = 3, entries = emptyList()))
        val blobHash = writeBlob(initialIndex) ?: throw RuntimeException("Failed to create blob")

        // Step 2: Create a tree containing index.json
        val treeInput = "100644 blob $blobHash\tindex.json\n"
        val treeHash = git.execWithStdin("mktree", input = treeInput)
            ?: throw RuntimeException("Failed to create tree")

        // Step 3: Create orphan commit (no parents)
        val commitHash = git.exec("commit-tree", treeHash, "-m", "Initialize JolliMemory summaries")
            ?: throw RuntimeException("Failed to create commit")

        // Step 4: Point the branch ref at the commit
        git.exec("update-ref", "refs/heads/$ORPHAN_BRANCH", commitHash)
            ?: throw RuntimeException("Failed to update ref")

        log.info("Orphan branch '%s' created successfully", ORPHAN_BRANCH)
    }

    /** Writes content as a git blob, returns the hash. */
    private fun writeBlob(content: String): String? {
        return git.execWithStdin("hash-object", "-w", "--stdin", input = content)
    }

    /** Updates a tree by adding/replacing a file. Handles nested paths (e.g. "summaries/abc.json"). */
    private fun updateTreeWithFile(currentTree: String, filePath: String, blobHash: String): String {
        val parts = filePath.split("/")

        if (parts.size == 1) {
            return replaceInTree(currentTree, parts[0], "100644", "blob", blobHash)
        }

        // Nested: recurse into subdirectory
        val dirName = parts[0]
        val remainingPath = parts.drop(1).joinToString("/")

        val lsResult = git.exec("ls-tree", currentTree, dirName)
        val emptyTree = { git.execWithStdin("mktree", input = "")
            ?: throw RuntimeException("Failed to create empty tree") }
        val subTreeHash = if (!lsResult.isNullOrBlank()) {
            val match = Regex("^(\\d+)\\s+tree\\s+([a-f0-9]+)\\t").find(lsResult)
            match?.groupValues?.get(2) ?: emptyTree()
        } else {
            emptyTree()
        }

        val newSubTree = updateTreeWithFile(subTreeHash, remainingPath, blobHash)
        return replaceInTree(currentTree, dirName, "040000", "tree", newSubTree)
    }

    /** Replaces or adds an entry in a tree object. */
    private fun replaceInTree(treeHash: String, name: String, mode: String, type: String, objectHash: String): String {
        val lsResult = git.exec("ls-tree", treeHash) ?: ""
        val existingEntries = lsResult.lines()
            .filter { it.isNotEmpty() }
            .filter { line -> line.split("\t").getOrNull(1) != name }
            .toMutableList()

        existingEntries.add("$mode $type $objectHash\t$name")
        existingEntries.sort()

        val treeInput = existingEntries.joinToString("\n") + "\n"
        return git.execWithStdin("mktree", input = treeInput)
            ?: throw RuntimeException("Failed to create tree")
    }

    /** Removes a file from a tree object. Handles nested paths (e.g. "summaries/abc.json"). */
    private fun removeFromTree(currentTree: String, filePath: String): String {
        val parts = filePath.split("/")

        if (parts.size == 1) {
            // Remove the entry from this tree level
            val lsResult = git.exec("ls-tree", currentTree) ?: ""
            val remaining = lsResult.lines()
                .filter { it.isNotEmpty() }
                .filter { line -> line.split("\t").getOrNull(1) != parts[0] }
            val treeInput = if (remaining.isEmpty()) "" else remaining.joinToString("\n") + "\n"
            return git.execWithStdin("mktree", input = treeInput)
                ?: throw RuntimeException("Failed to create tree")
        }

        // Nested: recurse into subdirectory
        val dirName = parts[0]
        val remainingPath = parts.drop(1).joinToString("/")

        val lsResult = git.exec("ls-tree", currentTree, dirName)
        if (lsResult.isNullOrBlank()) return currentTree // File doesn't exist, nothing to remove

        val match = Regex("^(\\d+)\\s+tree\\s+([a-f0-9]+)\\t").find(lsResult)
        val subTreeHash = match?.groupValues?.get(2) ?: return currentTree

        val newSubTree = removeFromTree(subTreeHash, remainingPath)
        return replaceInTree(currentTree, dirName, "040000", "tree", newSubTree)
    }

    /** Writes multiple files to the orphan branch in a single atomic commit. */
    private fun writeFilesToBranch(files: List<FileWrite>, message: String) {
        ensureOrphanBranch()

        val parentCommit = git.exec("rev-parse", "refs/heads/$ORPHAN_BRANCH")
            ?: throw RuntimeException("Failed to get branch tip")

        val baseTree = git.exec("rev-parse", "$parentCommit^{tree}")
            ?: throw RuntimeException("Failed to get tree")

        // Accumulate tree updates (writes and deletes)
        var currentTree = baseTree
        var written = 0
        var deleted = 0
        for (file in files) {
            if (file.delete) {
                currentTree = removeFromTree(currentTree, file.path)
                deleted++
            } else {
                val blobHash = writeBlob(file.content)
                    ?: throw RuntimeException("Failed to write blob for ${file.path}")
                currentTree = updateTreeWithFile(currentTree, file.path, blobHash)
                written++
            }
        }

        // Create commit
        val newCommit = git.exec("commit-tree", currentTree, "-p", parentCommit, "-m", message)
            ?: throw RuntimeException("Failed to create commit")

        // Update ref
        git.exec("update-ref", "refs/heads/$ORPHAN_BRANCH", newCommit)
            ?: throw RuntimeException("Failed to update ref")

        log.info("Updated branch '%s': %d written, %d deleted (commit: %s)", ORPHAN_BRANCH, written, deleted, newCommit.take(8))
    }
}
