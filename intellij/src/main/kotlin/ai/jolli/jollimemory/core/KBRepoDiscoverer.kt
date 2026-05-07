package ai.jolli.jollimemory.core

import java.nio.file.Files
import java.nio.file.Path

/**
 * Discovers all KB repositories under the KB parent directory.
 * Each valid KB folder has a `.jolli/config.json` with repo identity.
 */
object KBRepoDiscoverer {

    private val log = JmLogger.create("KBRepoDiscoverer")

    data class DiscoveredRepo(
        val kbRoot: Path,
        val repoName: String,
        val remoteUrl: String?,
        val isCurrentRepo: Boolean,
    )

    /**
     * Scans the KB parent directory for all valid KB folders.
     * @param currentRepoName The current project's repo name (for highlighting)
     * @param currentRemoteUrl The current project's remote URL (for matching)
     * @param customParent Optional custom parent path (overrides default)
     * @return List of discovered repos, current repo first
     */
    fun discover(
        currentRepoName: String?,
        currentRemoteUrl: String?,
        customParent: String? = null,
    ): List<DiscoveredRepo> {
        val parent = if (!customParent.isNullOrBlank()) Path.of(customParent) else KBPathResolver.KB_PARENT
        if (!Files.isDirectory(parent)) return emptyList()

        val repos = mutableListOf<DiscoveredRepo>()
        try {
            Files.list(parent).use { stream ->
                stream.filter { Files.isDirectory(it) }
                    .filter { Files.isDirectory(it.resolve(".jolli")) }
                    .forEach { dir ->
                        val mm = MetadataManager(dir.resolve(".jolli"))
                        val config = mm.readConfig()
                        val repoName = config.repoName ?: dir.fileName.toString()
                        val remoteUrl = config.remoteUrl
                        val isCurrent = isCurrentRepo(repoName, remoteUrl, currentRepoName, currentRemoteUrl)
                        repos.add(DiscoveredRepo(dir, repoName, remoteUrl, isCurrent))
                    }
            }
        } catch (e: Exception) {
            log.warn("Failed to scan KB parent directory: %s", e.message ?: "unknown")
        }

        // Sort: current repo first, then alphabetically
        repos.sortWith(compareByDescending<DiscoveredRepo> { it.isCurrentRepo }.thenBy { it.repoName })
        return repos
    }

    private fun isCurrentRepo(
        repoName: String,
        remoteUrl: String?,
        currentRepoName: String?,
        currentRemoteUrl: String?,
    ): Boolean {
        if (currentRemoteUrl != null && remoteUrl != null) {
            return normalizeUrl(remoteUrl) == normalizeUrl(currentRemoteUrl)
        }
        return currentRepoName != null && repoName == currentRepoName
    }

    private fun normalizeUrl(url: String): String {
        return url.removeSuffix("/").removeSuffix(".git").lowercase()
    }
}
