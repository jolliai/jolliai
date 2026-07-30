package ai.jolli.jollimemory.core

import java.nio.file.Path

/**
 * KBDataCache — shared data layer for all KB views (Tree, Timeline, A-Z).
 * Reads manifest entries from all discovered repos and provides sorted/grouped access.
 */
object KBDataCache {

    data class KBEntry(
        val repo: String,
        val branch: String?,
        val title: String?,
        val date: String?,
        val path: String,
        val type: String,
        val kbRoot: Path,
        val fullPath: Path,
        val isCurrentRepo: Boolean,
    )

    @Volatile
    private var cached: List<KBEntry> = emptyList()

    fun reload(repos: List<KBRepoDiscoverer.DiscoveredRepo>) {
        val entries = mutableListOf<KBEntry>()
        for (repo in repos) {
            // Manifest + index reads are native (Files.readString + Gson) — same
            // bypass VS Code's KbFoldersService.buildManifestLookup uses to keep
            // the sidebar off the ide-bridge hot path. See [KBFolderReader] for
            // the lockstep contract with the CLI schemas.
            val manifest = KBFolderReader.readManifest(repo.kbRoot)
            val index = KBFolderReader.readIndex(repo.kbRoot)
            val childHashes = index?.entries
                ?.filter { it.parentCommitHash != null }
                ?.map { it.commitHash }
                ?.toSet()
                ?: emptySet()

            for (entry in manifest.files) {
                if (entry.type == "commit" && entry.fileId in childHashes) continue
                entries.add(KBEntry(
                    repo = repo.repoName,
                    branch = entry.source.branch,
                    title = entry.title,
                    date = entry.source.generatedAt,
                    path = entry.path,
                    type = entry.type,
                    kbRoot = repo.kbRoot,
                    fullPath = repo.kbRoot.resolve(entry.path),
                    isCurrentRepo = repo.isCurrentRepo,
                ))
            }
        }
        cached = entries
    }

    fun all(): List<KBEntry> = cached

    /** All entries sorted by date descending (newest first), grouped by date label. */
    fun byTimeline(): List<Pair<String, List<KBEntry>>> {
        val now = java.time.LocalDate.now()
        val yesterday = now.minusDays(1)

        return cached
            .filter { it.type == "commit" }
            .sortedByDescending { it.date ?: "" }
            .groupBy { entry ->
                val date = try {
                    java.time.Instant.parse(entry.date).atZone(java.time.ZoneId.systemDefault()).toLocalDate()
                } catch (_: Exception) { null }
                when (date) {
                    now -> "Today"
                    yesterday -> "Yesterday"
                    null -> "Unknown"
                    else -> date.toString()
                }
            }
            .toList()
    }

    /** All entries sorted alphabetically as "repo :: branch :: title". */
    fun byAlpha(): List<KBEntry> {
        return cached
            .filter { it.type == "commit" }
            .sortedBy { "${it.repo} :: ${it.branch ?: ""} :: ${it.title ?: ""}" .lowercase() }
    }
}
