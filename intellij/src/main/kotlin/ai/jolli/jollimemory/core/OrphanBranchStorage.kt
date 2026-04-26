package ai.jolli.jollimemory.core

import ai.jolli.jollimemory.bridge.GitOps
import com.google.gson.GsonBuilder

/**
 * OrphanBranchStorage — StorageProvider backed by a git orphan branch.
 *
 * Stores files in the orphan branch using git plumbing commands
 * (hash-object, mktree, commit-tree, update-ref). Never checks out
 * the orphan branch.
 *
 * Extracted from SummaryStore as part of JOLLI-1309 storage abstraction.
 */
open class OrphanBranchStorage(private val git: GitOps) : StorageProvider {

    private val log = JmLogger.create("OrphanBranchStorage")
    private val gson = GsonBuilder().setPrettyPrinting().create()

    companion object {
        const val ORPHAN_BRANCH = JmLogger.ORPHAN_BRANCH
    }

    override fun readFile(path: String): String? {
        return git.readBranchFile(ORPHAN_BRANCH, path)
    }

    override fun writeFiles(files: List<FileWrite>, message: String) {
        ensure()

        val parentCommit = git.exec("rev-parse", "refs/heads/$ORPHAN_BRANCH")
            ?: throw RuntimeException("Failed to get branch tip")

        val baseTree = git.exec("rev-parse", "$parentCommit^{tree}")
            ?: throw RuntimeException("Failed to get tree")

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

        val newCommit = git.exec("commit-tree", currentTree, "-p", parentCommit, "-m", message)
            ?: throw RuntimeException("Failed to create commit")

        git.exec("update-ref", "refs/heads/$ORPHAN_BRANCH", newCommit)
            ?: throw RuntimeException("Failed to update ref")

        log.info("Updated branch '%s': %d written, %d deleted (commit: %s)", ORPHAN_BRANCH, written, deleted, newCommit.take(8))
    }

    override fun listFiles(prefix: String): List<String> {
        return git.listBranchFiles(ORPHAN_BRANCH, prefix)
    }

    override fun exists(): Boolean {
        return git.branchExists(ORPHAN_BRANCH)
    }

    override fun ensure() {
        if (git.branchExists(ORPHAN_BRANCH)) return

        log.info("Creating orphan branch '%s' using plumbing commands", ORPHAN_BRANCH)

        val initialIndex = gson.toJson(SummaryIndex(version = 3, entries = emptyList()))
        val blobHash = writeBlob(initialIndex) ?: throw RuntimeException("Failed to create blob")

        val treeInput = "100644 blob $blobHash\tindex.json\n"
        val treeHash = git.execWithStdin("mktree", input = treeInput)
            ?: throw RuntimeException("Failed to create tree")

        val commitHash = git.exec("commit-tree", treeHash, "-m", "Initialize JolliMemory summaries")
            ?: throw RuntimeException("Failed to create commit")

        git.exec("update-ref", "refs/heads/$ORPHAN_BRANCH", commitHash)
            ?: throw RuntimeException("Failed to update ref")

        log.info("Orphan branch '%s' created successfully", ORPHAN_BRANCH)
    }

    // ── Git plumbing internals ──────────────────────────────────────────

    private fun writeBlob(content: String): String? {
        return git.execWithStdin("hash-object", "-w", "--stdin", input = content)
    }

    private fun updateTreeWithFile(currentTree: String, filePath: String, blobHash: String): String {
        val parts = filePath.split("/")

        if (parts.size == 1) {
            return replaceInTree(currentTree, parts[0], "100644", "blob", blobHash)
        }

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

    private fun removeFromTree(currentTree: String, filePath: String): String {
        val parts = filePath.split("/")

        if (parts.size == 1) {
            val lsResult = git.exec("ls-tree", currentTree) ?: ""
            val remaining = lsResult.lines()
                .filter { it.isNotEmpty() }
                .filter { line -> line.split("\t").getOrNull(1) != parts[0] }
            val treeInput = if (remaining.isEmpty()) "" else remaining.joinToString("\n") + "\n"
            return git.execWithStdin("mktree", input = treeInput)
                ?: throw RuntimeException("Failed to create tree")
        }

        val dirName = parts[0]
        val remainingPath = parts.drop(1).joinToString("/")

        val lsResult = git.exec("ls-tree", currentTree, dirName)
        if (lsResult.isNullOrBlank()) return currentTree

        val match = Regex("^(\\d+)\\s+tree\\s+([a-f0-9]+)\\t").find(lsResult)
        val subTreeHash = match?.groupValues?.get(2) ?: return currentTree

        val newSubTree = removeFromTree(subTreeHash, remainingPath)
        return replaceInTree(currentTree, dirName, "040000", "tree", newSubTree)
    }
}
