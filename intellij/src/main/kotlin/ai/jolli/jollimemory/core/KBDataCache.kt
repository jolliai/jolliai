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
            val mm = MetadataManager(repo.kbRoot.resolve(".jolli"))
            val manifest = mm.readManifest()
            for (entry in manifest.files) {
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
