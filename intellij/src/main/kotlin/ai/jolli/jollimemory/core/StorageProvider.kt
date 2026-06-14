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

    /**
     * Renders the visible topic-KB wiki at `<kbRoot>/_wiki/` from the given pages
     * (full wipe + rewrite). No-op for storage backends that have no visible layer
     * (e.g. orphan-branch-only). Implemented by [FolderStorage]; delegated by
     * [DualWriteStorage].
     */
    fun renderTopicWiki(pages: List<TopicPage>) {
        // no-op by default
    }

    /** True when the visible wiki exists (`_wiki/_index.md` present). False for backends without a visible layer. */
    fun isTopicWikiPresent(): Boolean = false
}
