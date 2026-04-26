package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path

/**
 * KBPathResolver — resolves the Knowledge Base root folder for a given repository.
 *
 * Default location: ~/Documents/jolli/{repoName}/
 *
 * Collision handling:
 * - If folder exists and .jolli/config.json has matching remoteUrl → reuse
 * - If folder exists but remoteUrl differs (different repo, same name) → add suffix: {repoName}-2, -3, etc.
 * - If user has set a custom path in JolliMemoryConfig → use that directly
 *
 * Part of JOLLI-1309 / Step 1.4.
 */
object KBPathResolver {

    private val log = JmLogger.create("KBPathResolver")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    /** Default parent directory for all KB folders. */
    private val KB_PARENT: Path = Path.of(System.getProperty("user.home"), "Documents", "jolli")

    /**
     * Resolves the KB root path for a repository.
     *
     * @param repoName The repository name (typically the git directory name)
     * @param remoteUrl The origin remote URL (for identity matching), or null if no remote
     * @param customPath User-configured custom path from JolliMemoryConfig, or null for default
     * @return The resolved KB root path
     */
    fun resolve(repoName: String, remoteUrl: String?, customPath: String? = null): Path {
        // Custom path is treated as parent directory (like ~/Documents/jolli/),
        // repoName is always appended to keep repos separated
        val parent = if (!customPath.isNullOrBlank()) Path.of(customPath) else KB_PARENT
        val basePath = parent.resolve(repoName)

        // Folder doesn't exist yet — use it
        if (!Files.isDirectory(basePath)) {
            return basePath
        }

        // Folder exists — check if it belongs to the same repo
        val existingConfig = readKBConfig(basePath)
        if (existingConfig != null && isSameRepo(existingConfig, remoteUrl, repoName)) {
            return basePath
        }

        // Collision: different repo with same name — find next available suffix
        return findAvailablePath(repoName, remoteUrl)
    }

    /**
     * Initializes the KB folder by writing repo identity to .jolli/config.json.
     *
     * Should be called after [resolve] when the KB folder is first created.
     */
    fun initializeKBFolder(kbRoot: Path, repoName: String, remoteUrl: String?) {
        val manager = MetadataManager(kbRoot.resolve(".jolli"))
        manager.ensure()

        val config = manager.readConfig()
        manager.saveConfig(config.copy(
            remoteUrl = remoteUrl,
            repoName = repoName,
        ))
        log.info("KB folder initialized: %s (remote=%s)", kbRoot, remoteUrl ?: "none")
    }

    /**
     * Extracts the repository name from a project path.
     * Uses the directory name of the git root.
     */
    fun extractRepoName(projectPath: String): String {
        return Path.of(projectPath).fileName?.toString() ?: "unknown"
    }

    /**
     * Gets the remote origin URL for a repository, or null if not configured.
     */
    fun getRemoteUrl(projectPath: String): String? {
        return try {
            val pb = ProcessBuilder("git", "remote", "get-url", "origin")
                .directory(java.io.File(projectPath))
                .redirectErrorStream(false)
            val process = pb.start()
            val output = process.inputStream.bufferedReader().use { it.readText().trim() }
            process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (process.exitValue() == 0 && output.isNotBlank()) output else null
        } catch (_: Exception) {
            null
        }
    }

    // ── Internal ───────────────────────────────────────────────────────────

    private fun isSameRepo(config: KBConfig, remoteUrl: String?, repoName: String): Boolean {
        // If both have remote URLs, compare them (normalized)
        if (config.remoteUrl != null && remoteUrl != null) {
            return normalizeRemoteUrl(config.remoteUrl) == normalizeRemoteUrl(remoteUrl)
        }
        // If neither has a remote, match by repo name (or folder name for legacy configs without repoName)
        if (config.remoteUrl == null && remoteUrl == null) {
            return config.repoName == null || config.repoName == repoName
        }
        // One has remote, other doesn't — assume different repos
        return false
    }

    /** Normalizes a git remote URL for comparison (strips .git suffix, trailing slash). */
    private fun normalizeRemoteUrl(url: String): String {
        return url.trimEnd('/').removeSuffix(".git").lowercase()
    }

    private fun findAvailablePath(repoName: String, remoteUrl: String?): Path {
        for (suffix in 2..99) {
            val candidate = KB_PARENT.resolve("$repoName-$suffix")
            if (!Files.isDirectory(candidate)) {
                return candidate
            }
            // Check if this suffixed folder belongs to the same repo
            val config = readKBConfig(candidate)
            if (config != null && isSameRepo(config, remoteUrl, repoName)) {
                return candidate
            }
        }
        // Extremely unlikely fallback
        return KB_PARENT.resolve("$repoName-${System.currentTimeMillis()}")
    }

    private fun readKBConfig(kbRoot: Path): KBConfig? {
        val configPath = kbRoot.resolve(".jolli/config.json")
        if (!Files.exists(configPath)) return null
        return try {
            val json = Files.readString(configPath, StandardCharsets.UTF_8)
            gson.fromJson(json, KBConfig::class.java)
        } catch (_: Exception) {
            null
        }
    }
}
