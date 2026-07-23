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
}
