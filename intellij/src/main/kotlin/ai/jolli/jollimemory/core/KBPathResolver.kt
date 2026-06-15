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
    val KB_PARENT: Path = Path.of(System.getProperty("user.home"), "Documents", "jolli")

    /**
     * Resolves the KB root path for a repository.
     *
     * @param repoName The repository name (typically the git directory name)
     * @param remoteUrl The origin remote URL (for identity matching), or null if no remote
     * @param customPath User-configured custom path from JolliMemoryConfig, or null for default
     * @return The resolved KB root path
     */
    /** Resolves the Memory Bank parent dir from an optional custom path. */
    private fun resolveParent(customPath: String?): Path =
        if (!customPath.isNullOrBlank()) Path.of(customPath) else KB_PARENT

    fun resolve(repoName: String, remoteUrl: String?, customPath: String? = null): Path {
        // Custom path is treated as parent directory (like ~/Documents/jolli/),
        // repoName is always appended to keep repos separated
        val parent = resolveParent(customPath)
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
        return findAvailablePath(parent, repoName, remoteUrl)
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
     * Returns every existing KB folder (`<repo>` and `<repo>-2` … `<repo>-99`)
     * under the Memory Bank parent whose `.jolli/config.json` identity matches
     * this repo. Read-only.
     *
     * Used by the Migrate-to-Memory-Bank flow to fold a *pile* of duplicates in
     * one pass: earlier buggy runs left several `<repo>-N` folders all sharing one
     * identity, and archiving only one would clear them one-click-at-a-time. Only
     * true identity matches are returned, so it is safe to feed to [archiveKBFolder].
     * Port of the canonical TS `findRepoFolders`.
     */
    fun findRepoFolders(repoName: String, remoteUrl: String?, customPath: String? = null): List<Path> {
        val parent = resolveParent(customPath)
        val out = mutableListOf<Path>()
        val base = parent.resolve(repoName)
        if (Files.isDirectory(base)) {
            val baseConfig = readKBConfig(base)
            if (baseConfig != null && isSameRepo(baseConfig, remoteUrl, repoName)) out.add(base)
        }
        for (suffix in 2..99) {
            val candidate = parent.resolve("$repoName-$suffix")
            if (!Files.isDirectory(candidate)) continue
            val config = readKBConfig(candidate)
            if (config != null && isSameRepo(config, remoteUrl, repoName)) out.add(candidate)
        }
        return out
    }

    /**
     * Returns the next unused `-N` KB path (or the bare `<repo>` when free) so the
     * Migrate flow can build into a fresh folder and archive the prior ones.
     * Port of the canonical TS `findFreshKBPath`.
     */
    fun findFreshKBPath(repoName: String, customPath: String? = null): Path {
        val parent = resolveParent(customPath)
        val basePath = parent.resolve(repoName)
        if (!Files.isDirectory(basePath)) return basePath
        for (suffix in 2..99) {
            val candidate = parent.resolve("$repoName-$suffix")
            if (!Files.isDirectory(candidate)) return candidate
        }
        return parent.resolve("$repoName-${System.currentTimeMillis()}")
    }

    /**
     * Moves a KB repo folder out of the active Memory Bank area into the hidden,
     * per-Memory-Bank archive dir `<parent>/.jolli/archive/<name>-<timestamp>/`.
     *
     * Replaces the old "archive = rewrite config.json identity in place" step,
     * which left the folder visible in the IDE folder views AND still tracked by
     * the vault git. The archive dir is hidden (leading dot → filtered by the IDE
     * explorers) and unowned by the sync classifier, while staying inside the
     * Memory Bank so it travels with `localFolder` and stays recoverable (the
     * orphan branch remains the system of record).
     *
     * Returns the destination path, or null if [kbRoot] doesn't exist (nothing to
     * archive) or the move fails — callers log and proceed, since a stale visible
     * folder is a lesser evil than aborting a rebuild. Mirrors the canonical TS
     * `archiveKBFolder`; both IDEs resolve folders in the same Memory Bank.
     */
    fun archiveKBFolder(kbRoot: Path, customPath: String? = null): Path? {
        if (!Files.isDirectory(kbRoot)) return null
        val parent = resolveParent(customPath)
        val archiveDir = parent.resolve(".jolli").resolve("archive")
        val name = kbRoot.fileName.toString()
        // Timestamp keeps repeated archives distinct; the counter guards against
        // same-millisecond collisions (rapid rebuilds).
        var dest = archiveDir.resolve("$name-${System.currentTimeMillis()}")
        var n = 2
        while (Files.exists(dest) && n <= 99) {
            dest = archiveDir.resolve("$name-${System.currentTimeMillis()}-$n")
            n++
        }
        return try {
            Files.createDirectories(archiveDir)
            Files.move(kbRoot, dest)
            log.info("Archived KB folder: %s → %s", kbRoot, dest)
            dest
        } catch (e: Exception) {
            log.warn("Failed to archive KB folder %s: %s", kbRoot, e.message)
            null
        }
    }

    /**
     * Extracts the canonical repository name from a project path.
     * Three-layer fallback matching the CLI's extractRepoName():
     *   1. remote.origin.url basename (worktrees + main repo resolve identically)
     *   2. git rev-parse --git-common-dir parent basename (local-only worktrees)
     *   3. directory basename (last resort)
     */
    fun extractRepoName(projectPath: String): String {
        // Layer 1: remote URL basename — canonical for repos with a remote
        try {
            val remoteUrl = getRemoteUrl(projectPath)
            if (remoteUrl != null) {
                val name = remoteUrl.trimEnd('/').removeSuffix(".git")
                    .substringAfterLast('/').substringAfterLast(':')
                if (name.isNotBlank()) return name
            }
        } catch (_: Exception) { /* fall through */ }

        // Layer 2: git-common-dir — follows worktree pointer back to main repo
        try {
            val pb = ProcessBuilder("git", "rev-parse", "--git-common-dir")
                .directory(java.io.File(projectPath))
                .redirectErrorStream(false)
            val process = pb.start()
            val output = process.inputStream.bufferedReader().use { it.readText().trim() }
            process.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)
            if (process.exitValue() == 0 && output.isNotBlank()) {
                val commonDir = Path.of(output)
                // --git-common-dir returns the .git dir; parent is the repo root
                val repoRoot = if (commonDir.isAbsolute) commonDir.parent else Path.of(projectPath).resolve(commonDir).normalize().parent
                val name = repoRoot?.fileName?.toString()
                if (!name.isNullOrBlank()) return name
            }
        } catch (_: Exception) { /* fall through */ }

        // Layer 3: directory basename (last resort)
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
        // Legacy config without remoteUrl — match by repoName to avoid
        // false collisions that create unnecessary -2 suffixed folders
        if (config.remoteUrl == null) {
            return config.repoName == null || config.repoName == repoName
        }
        // Config has remote but current project doesn't — assume different repos
        return false
    }

    /**
     * Normalizes a git remote URL for comparison: folds SSH transports into
     * the https form, then strips trailing slashes + `.git` and lowercases.
     */
    private fun normalizeRemoteUrl(url: String): String {
        return foldGitTransportToHttps(url).trimEnd('/').removeSuffix(".git").lowercase()
    }

    private val SSH_URL_REGEX = Regex("^(?:git\\+)?ssh://(?:[^@/]+@)?([^/:]+)(?::(\\d+))?/(.+)$", RegexOption.IGNORE_CASE)
    private val GIT_URL_REGEX = Regex("^git://([^/:]+)(?::(\\d+))?/(.+)$", RegexOption.IGNORE_CASE)
    private val SCP_URL_REGEX = Regex("^[^@/:]+@([^/:]+):(.+)$")

    /**
     * Folds the SSH transport forms of a git remote URL into the https form so
     * all transports of the same repo compare equal — `git@host:owner/repo`,
     * `ssh://[user@]host[:port]/owner/repo`, `git://host/owner/repo` and
     * `https://host/owner/repo` are the same repo, and treating them as
     * different splits the Memory Bank into `<repo>` / `<repo>-2` folders when
     * the user switches clone transport.
     *
     * The SCP form requires the `user@` prefix on purpose: a bare `host:path`
     * was never folded by earlier releases either, and requiring the `@` keeps
     * non-URL strings that merely contain a `:` (Windows drive paths like
     * `C:/repos/foo`) from being mangled into fake https URLs.
     *
     * Port of the canonical TypeScript implementation in
     * `cli/src/core/KBPathResolver.ts foldGitTransportToHttps` — the two MUST
     * stay in lockstep, since both IDEs resolve folders in the same Memory
     * Bank and divergent folding sends them to different folders.
     */
    internal fun foldGitTransportToHttps(url: String): String {
        // The scheme's DEFAULT port (ssh 22 / git 9418) is dropped — it carries
        // no identity — but a non-default port is preserved so two self-hosted
        // forges on `host:2222` and `host:2223` stay distinct repos.
        SSH_URL_REGEX.find(url)?.let {
            return "https://${it.groupValues[1]}${nonDefaultPortSegment(it.groupValues[2], "22")}/${it.groupValues[3]}"
        }
        GIT_URL_REGEX.find(url)?.let {
            return "https://${it.groupValues[1]}${nonDefaultPortSegment(it.groupValues[2], "9418")}/${it.groupValues[3]}"
        }
        SCP_URL_REGEX.find(url)?.let { return "https://${it.groupValues[1]}/${it.groupValues[2]}" }
        return url
    }

    /** `:<port>` when present and not the scheme's default, else empty. */
    private fun nonDefaultPortSegment(port: String, schemeDefault: String): String {
        if (port.isEmpty() || port == schemeDefault) return ""
        return ":$port"
    }

    private fun findAvailablePath(parent: Path, repoName: String, remoteUrl: String?): Path {
        // Pass 1: reuse an existing folder that already belongs to this repo. Scan
        // ALL suffixes first — a folder archived out of the ladder leaves a numbering
        // hole, and stopping at that hole (claiming it fresh) while a higher-numbered
        // folder already holds this repo is what spawned duplicate <repo>-N folders.
        // Mirrors the TS findAvailablePathAndClaim two-pass fix.
        var firstUnused: Path? = null
        for (suffix in 2..99) {
            val candidate = parent.resolve("$repoName-$suffix")
            if (!Files.isDirectory(candidate)) {
                if (firstUnused == null) firstUnused = candidate
                continue
            }
            val config = readKBConfig(candidate)
            if (config != null && isSameRepo(config, remoteUrl, repoName)) {
                return candidate
            }
        }
        // Pass 2: no existing folder for this repo — use the lowest free slot.
        // The millis-suffixed name is the 99-collision safety net only.
        return firstUnused ?: parent.resolve("$repoName-${System.currentTimeMillis()}")
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
