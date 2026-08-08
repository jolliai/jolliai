package ai.jolli.jollimemory.core

/**
 * StorageProvider — abstraction for reading/writing JolliMemory files.
 *
 * The production implementation is a thin adapter to the CLI-owned provider.
 */
interface StorageProvider {
    fun readFile(path: String): String?
    fun writeFiles(files: List<FileWrite>, message: String)
    fun listFiles(prefix: String): List<String>
    fun exists(): Boolean
    fun ensure()

    /**
     * Reads N paths in one call; absent paths map to null. The default is a
     * per-path loop — [ai.jolli.jollimemory.core.StorageFactory]'s CLI-backed
     * provider overrides it with the bridge's single-round-trip `batch-read`,
     * which is what keeps list-then-read screens from costing N bridge calls.
     */
    fun batchReadFiles(paths: List<String>): Map<String, String?> =
        paths.associateWith { readFile(it) }
}
