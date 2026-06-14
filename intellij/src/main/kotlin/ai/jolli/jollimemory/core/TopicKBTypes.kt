package ai.jolli.jollimemory.core

/**
 * Topic KB — shared type declarations for the topic-centric knowledge base.
 * Pure type module: no runtime behavior.
 *
 * Kotlin port of `cli/src/core/TopicKBTypes.ts`. Field order mirrors the TS
 * interfaces so Gson serialization stays byte-stable with the CLI/VS Code
 * `JSON.stringify` output (the `topics/` JSON layer is synced cross-device).
 */

/** The four source streams folded into the knowledge base. */
object SourceType {
    const val SUMMARY = "summary"
    const val PLAN = "plan"
    const val NOTE = "note"
    const val USERFILE = "userfile"

    /** All types, in the canonical order used by [ProcessedSet] and tie-break ranking. */
    val ALL = listOf(SUMMARY, PLAN, NOTE, USERFILE)
}

/**
 * A single ingestable source, identified stably and timestamped for ordering.
 *
 * @property type one of [SourceType]
 * @property id stable identity: commit hash / plan slug / note id / `path@fingerprint`
 * @property timestamp ISO 8601; parsed to epoch for chronological ordering (may carry tz offset)
 * @property branch originating branch for branch-scoped sources (summary/plan/note);
 *   authoritative input to a topic page's `relatedBranches`. Absent for userfiles and
 *   for refs deserialized from pages written before this field existed.
 */
data class SourceRef(
    val type: String,
    val id: String,
    val timestamp: String,
    val branch: String? = null,
)

/** High-water mark = the set of already-ingested source IDs, grouped by type. */
data class ProcessedSet(
    val schemaVersion: Int = 1,
    val processed: Map<String, List<String>> = emptyMap(),
)

/** One entry in `topics/index.json`. Drives index-driven routing. */
data class TopicIndexEntry(
    val stableSlug: String,
    val title: String,
    val summary: String,
    val relatedBranches: List<String> = emptyList(),
    val sourceRefs: List<SourceRef> = emptyList(),
    val lastUpdatedAt: String,
)

/** `topics/index.json` shape. */
data class TopicIndex(
    val schemaVersion: Int = 1,
    val topics: List<TopicIndexEntry> = emptyList(),
)

/** Canonical topic page (`topics/<stableSlug>.json`). */
data class TopicPage(
    val schemaVersion: Int = 1,
    val stableSlug: String,
    val title: String,
    val content: String,
    val relatedBranches: List<String> = emptyList(),
    val sourceRefs: List<SourceRef> = emptyList(),
    val lastUpdatedAt: String,
)
