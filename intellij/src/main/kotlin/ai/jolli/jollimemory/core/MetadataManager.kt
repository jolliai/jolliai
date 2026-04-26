package ai.jolli.jollimemory.core

import com.google.gson.Gson
import com.google.gson.GsonBuilder
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardCopyOption
import java.time.Instant

/**
 * MetadataManager — manages the .jolli/ metadata directory inside a KB root folder.
 *
 * Responsible for:
 * - manifest.json: tracking AI-generated files (commit summaries, plans, notes)
 * - branches.json: branch name ↔ folder name mapping
 * - index.json: rebuildable summary cache
 * - config.json: KB-level settings
 *
 * Part of JOLLI-1309 / Step 1.3.
 */
class MetadataManager(private val jolliDir: Path) {

    private val log = JmLogger.create("MetadataManager")
    private val gson: Gson = GsonBuilder().setPrettyPrinting().create()

    // ── File paths ─────────────────────────────────────────────────────────

    private val manifestPath: Path get() = jolliDir.resolve("manifest.json")
    private val branchesPath: Path get() = jolliDir.resolve("branches.json")
    private val indexPath: Path get() = jolliDir.resolve("index.json")
    private val configPath: Path get() = jolliDir.resolve("config.json")

    // ── Init ───────────────────────────────────────────────────────────────

    /** Ensures the .jolli/ directory and default files exist. */
    fun ensure() {
        Files.createDirectories(jolliDir)
        if (!Files.exists(manifestPath)) {
            atomicWrite(manifestPath, gson.toJson(Manifest()))
        }
        if (!Files.exists(branchesPath)) {
            atomicWrite(branchesPath, gson.toJson(BranchesJson()))
        }
        if (!Files.exists(configPath)) {
            atomicWrite(configPath, gson.toJson(KBConfig()))
        }
    }

    // ── Manifest ───────────────────────────────────────────────────────────

    /** Reads the manifest, returning an empty manifest if the file doesn't exist or is invalid. */
    fun readManifest(): Manifest {
        return readJson(manifestPath, Manifest::class.java) ?: Manifest()
    }

    /** Adds or updates a manifest entry (matched by fileId). */
    fun updateManifest(entry: ManifestEntry) {
        val manifest = readManifest()
        val updated = manifest.files.filter { it.fileId != entry.fileId } + entry
        atomicWrite(manifestPath, gson.toJson(manifest.copy(files = updated)))
        log.info("Manifest updated: %s (%s)", entry.path, entry.type)
    }

    /** Removes a manifest entry by fileId. Returns true if an entry was removed. */
    fun removeFromManifest(fileId: String): Boolean {
        val manifest = readManifest()
        val filtered = manifest.files.filter { it.fileId != fileId }
        if (filtered.size == manifest.files.size) return false
        atomicWrite(manifestPath, gson.toJson(manifest.copy(files = filtered)))
        log.info("Manifest entry removed: %s", fileId)
        return true
    }

    /** Finds a manifest entry by its path. */
    fun findByPath(path: String): ManifestEntry? {
        return readManifest().files.find { it.path == path }
    }

    /** Finds a manifest entry by its fileId. */
    fun findById(fileId: String): ManifestEntry? {
        return readManifest().files.find { it.fileId == fileId }
    }

    /** Updates the path of a manifest entry (e.g. when a file is moved/renamed). */
    fun updatePath(fileId: String, newPath: String): Boolean {
        val manifest = readManifest()
        val entry = manifest.files.find { it.fileId == fileId } ?: return false
        val updated = manifest.files.map {
            if (it.fileId == fileId) it.copy(path = newPath) else it
        }
        atomicWrite(manifestPath, gson.toJson(manifest.copy(files = updated)))
        return true
    }

    // ── Branch mapping ─────────────────────────────────────────────────────

    /**
     * Resolves the folder name for a git branch.
     *
     * If a mapping already exists, returns the existing folder name.
     * Otherwise, transcodes the branch name and creates a new mapping.
     */
    fun resolveFolderForBranch(branchName: String): String {
        val branches = readBranches()

        // Check existing mapping
        val existing = branches.mappings.find { it.branch == branchName }
        if (existing != null) return existing.folder

        // Create new mapping
        val folder = transcodeBranchName(branchName)
        val mapping = BranchMapping(
            folder = folder,
            branch = branchName,
            createdAt = Instant.now().toString(),
        )
        val updated = branches.copy(mappings = branches.mappings + mapping)
        atomicWrite(branchesPath, gson.toJson(updated))
        log.info("Branch mapping created: %s → %s", branchName, folder)
        return folder
    }

    /** Updates the branch mapping for a folder (e.g. after branch rename). */
    fun updateBranchMapping(folder: String, branch: String) {
        val branches = readBranches()
        val updated = branches.mappings.map {
            if (it.folder == folder) it.copy(branch = branch) else it
        }
        atomicWrite(branchesPath, gson.toJson(branches.copy(mappings = updated)))
    }

    /** Returns all branch mappings. */
    fun listBranchMappings(): List<BranchMapping> {
        return readBranches().mappings
    }

    /** Reads the branches.json file. */
    fun readBranches(): BranchesJson {
        return readJson(branchesPath, BranchesJson::class.java) ?: BranchesJson()
    }

    /**
     * Renames a branch folder: updates branches.json and all manifest entries under it.
     * @return number of manifest entries updated
     */
    fun renameBranchFolder(oldFolder: String, newFolder: String): Int {
        // Update branches.json
        val branches = readBranches()
        val updatedMappings = branches.mappings.map {
            if (it.folder == oldFolder) it.copy(folder = newFolder) else it
        }
        atomicWrite(branchesPath, gson.toJson(branches.copy(mappings = updatedMappings)))

        // Update manifest entries whose path starts with oldFolder/
        val manifest = readManifest()
        var count = 0
        val updatedFiles = manifest.files.map { entry ->
            if (entry.path.startsWith("$oldFolder/")) {
                count++
                entry.copy(path = entry.path.replaceFirst("$oldFolder/", "$newFolder/"))
            } else entry
        }
        if (count > 0) {
            atomicWrite(manifestPath, gson.toJson(manifest.copy(files = updatedFiles)))
        }
        log.info("Branch folder renamed: %s → %s (%d entries updated)", oldFolder, newFolder, count)
        return count
    }

    /**
     * Removes a branch folder from branches.json and all its manifest entries.
     * @return number of manifest entries removed
     */
    fun removeBranchFolder(folder: String): Int {
        // Remove from branches.json
        val branches = readBranches()
        val updatedMappings = branches.mappings.filter { it.folder != folder }
        atomicWrite(branchesPath, gson.toJson(branches.copy(mappings = updatedMappings)))

        // Remove manifest entries under this folder
        val manifest = readManifest()
        val remaining = manifest.files.filter { !it.path.startsWith("$folder/") }
        val removed = manifest.files.size - remaining.size
        if (removed > 0) {
            atomicWrite(manifestPath, gson.toJson(manifest.copy(files = remaining)))
        }
        log.info("Branch folder removed: %s (%d entries removed)", folder, removed)
        return removed
    }

    // ── Reconciliation (external change detection) ─────────────────────────

    /**
     * Reconciles manifest with the actual filesystem.
     *
     * Detects:
     * - Deleted files: manifest path no longer exists → remove entry
     * - Moved files: old path gone but same fingerprint at new path → update entry
     *
     * @param kbRoot the KB root folder path
     * @return number of entries fixed
     */
    fun reconcile(kbRoot: java.nio.file.Path): Int {
        val manifest = readManifest()
        if (manifest.files.isEmpty()) return 0

        var fixed = 0
        val updatedFiles = mutableListOf<ManifestEntry>()

        // Build a fingerprint → path map of all current .md files for move detection
        val currentFiles = mutableMapOf<String, String>() // fingerprint → relativePath
        try {
            java.nio.file.Files.walk(kbRoot).use { stream ->
                stream.filter { java.nio.file.Files.isRegularFile(it) }
                    .filter { it.toString().endsWith(".md") }
                    .filter { !kbRoot.relativize(it).toString().startsWith(".jolli") }
                    .forEach { file ->
                        try {
                            val content = java.nio.file.Files.readString(file, java.nio.charset.StandardCharsets.UTF_8)
                            val fp = FolderStorage.sha256(content)
                            currentFiles[fp] = kbRoot.relativize(file).toString()
                        } catch (_: Exception) {}
                    }
            }
        } catch (_: Exception) {}

        for (entry in manifest.files) {
            val filePath = kbRoot.resolve(entry.path)
            if (java.nio.file.Files.exists(filePath)) {
                // File exists — keep as is
                updatedFiles.add(entry)
            } else {
                // File missing — try to find by fingerprint (moved)
                val newPath = currentFiles[entry.fingerprint]
                if (newPath != null && newPath != entry.path) {
                    updatedFiles.add(entry.copy(path = newPath))
                    fixed++
                    log.info("Reconcile: moved %s → %s", entry.path, newPath)
                } else {
                    // Truly deleted — drop from manifest
                    fixed++
                    log.info("Reconcile: removed %s (file deleted)", entry.path)
                }
            }
        }

        if (fixed > 0) {
            atomicWrite(manifestPath, gson.toJson(manifest.copy(files = updatedFiles)))
            log.info("Reconciliation: %d entries fixed", fixed)
        }
        return fixed
    }

    // ── Index (rebuildable cache) ──────────────────────────────────────────

    /** Reads the cached index. Returns null if no index exists. */
    fun readIndex(): SummaryIndex? {
        return readJson(indexPath, SummaryIndex::class.java)
    }

    /** Writes the index cache. */
    fun writeIndex(index: SummaryIndex) {
        atomicWrite(indexPath, gson.toJson(index))
    }

    /**
     * Rebuilds the index from manifest entries by scanning summary JSON files.
     *
     * Reads each "commit" type entry from the manifest, loads its corresponding
     * summary JSON from .jolli/summaries/, and builds index entries.
     */
    fun rebuildIndex(summariesDir: Path): SummaryIndex {
        val manifest = readManifest()
        val entries = mutableListOf<SummaryIndexEntry>()

        for (mEntry in manifest.files.filter { it.type == "commit" }) {
            val hash = mEntry.fileId
            val summaryPath = summariesDir.resolve("$hash.json")
            if (!Files.exists(summaryPath)) continue

            try {
                val json = Files.readString(summaryPath, StandardCharsets.UTF_8)
                val summary = gson.fromJson(json, CommitSummary::class.java) ?: continue
                entries.add(
                    SummaryIndexEntry(
                        commitHash = summary.commitHash,
                        parentCommitHash = summary.children?.firstOrNull()?.commitHash,
                        treeHash = summary.treeHash,
                        commitType = summary.commitType,
                        commitMessage = summary.commitMessage,
                        commitDate = summary.commitDate,
                        branch = summary.branch,
                        generatedAt = summary.generatedAt,
                        topicCount = summary.topics?.size,
                        diffStats = summary.stats,
                    )
                )
            } catch (e: Exception) {
                log.warn("Failed to parse summary for index rebuild: %s — %s", hash, e.message)
            }
        }

        val index = SummaryIndex(version = 3, entries = entries)
        writeIndex(index)
        log.info("Index rebuilt: %d entries", entries.size)
        return index
    }

    // ── Config ─────────────────────────────────────────────────────────────

    /** Reads KB config, returning defaults if file doesn't exist. */
    fun readConfig(): KBConfig {
        return readJson(configPath, KBConfig::class.java) ?: KBConfig()
    }

    /** Saves KB config. */
    fun saveConfig(config: KBConfig) {
        atomicWrite(configPath, gson.toJson(config))
    }

    // ── Migration state ───────────────────────────────────────────────────

    private val migrationPath: Path get() = jolliDir.resolve("migration.json")

    /** Reads migration state, or null if no migration has been started. */
    fun readMigrationState(): MigrationState? {
        return readJson(migrationPath, MigrationState::class.java)
    }

    /** Saves migration state. */
    fun saveMigrationState(state: MigrationState) {
        atomicWrite(migrationPath, gson.toJson(state))
    }

    // ── Branch name transcoding ────────────────────────────────────────────

    companion object {
        /** Characters that are unsafe in file/folder names. */
        private val UNSAFE_CHARS = Regex("[/\\\\:*?~^]")

        /**
         * Transcodes a git branch name into a safe folder name.
         *
         * Rules:
         * 1. Replace `/`, `\`, `:`, `*`, `?`, `~`, `^` → `-`
         * 2. Replace `..` → `--`
         * 3. Collapse consecutive `-`
         * 4. Trim leading/trailing `.` and `-`
         */
        fun transcodeBranchName(branch: String): String {
            // 1. Replace unsafe chars with `-`
            var result = UNSAFE_CHARS.replace(branch, "-")
            // 2. Collapse 3+ consecutive dashes (from e.g. `///`) into single `-`
            result = result.replace(Regex("-{3,}"), "-")
            // 3. Replace `..` with `--` (after collapse so `--` is preserved)
            result = result.replace("..", "--")
            // 4. Trim leading/trailing `.` and `-`
            result = result.trimStart('.', '-').trimEnd('.', '-')
            return result.ifEmpty { "default" }
        }
    }

    // ── Internal helpers ───────────────────────────────────────────────────

    private fun <T> readJson(path: Path, clazz: Class<T>): T? {
        if (!Files.exists(path)) return null
        return try {
            val json = Files.readString(path, StandardCharsets.UTF_8)
            gson.fromJson(json, clazz)
        } catch (e: Exception) {
            log.warn("Failed to read %s: %s", path.fileName, e.message)
            null
        }
    }

    private fun atomicWrite(targetPath: Path, content: String) {
        Files.createDirectories(targetPath.parent)
        val tmp = Files.createTempFile(targetPath.parent, ".jolli-", ".tmp")
        try {
            Files.writeString(tmp, content, StandardCharsets.UTF_8)
            Files.move(tmp, targetPath, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: Exception) {
            Files.deleteIfExists(tmp)
            throw e
        }
    }
}
