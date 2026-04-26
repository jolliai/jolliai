package ai.jolli.jollimemory.core

/**
 * StorageProvider — abstraction for reading/writing JolliMemory files.
 *
 * Implementations:
 * - OrphanBranchStorage: current git plumbing-based storage (orphan branch)
 * - FolderStorage: local filesystem storage (future, Phase 1.2)
 */
interface StorageProvider {
    fun readFile(path: String): String?
    fun writeFiles(files: List<FileWrite>, message: String)
    fun listFiles(prefix: String): List<String>
    fun exists(): Boolean
    fun ensure()
}
