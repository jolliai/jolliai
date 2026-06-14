package ai.jolli.jollimemory.core

/**
 * ProcessedSourceStore — the topic-KB high-water mark, stored as the set of
 * already-ingested source IDs (NOT a timestamp). Decouples "has this source
 * been processed" from "what is its logical time" so out-of-order sources are
 * never skipped. Path: `topics/processed.json`, written via the [StorageProvider].
 *
 * Kotlin port of `cli/src/core/ProcessedSourceStore.ts`.
 */
object ProcessedSourceStore {

    private val log = JmLogger.create("ProcessedSourceStore")
    private const val PROCESSED_PATH = "topics/processed.json"

    /** A fresh set with all four buckets present, in canonical order. */
    fun emptyProcessedSet(): ProcessedSet =
        ProcessedSet(schemaVersion = 1, processed = canonicalBuckets(emptyMap()))

    /** Reads `topics/processed.json`; missing or unparseable → empty set (never throws). */
    fun readProcessedSet(storage: StorageProvider): ProcessedSet {
        val raw = storage.readFile(PROCESSED_PATH) ?: return emptyProcessedSet()
        val parsed = TopicJson.parse(raw, ProcessedSet::class.java)
        if (parsed == null) {
            log.warn("Failed to parse %s — treating as empty", PROCESSED_PATH)
            return emptyProcessedSet()
        }
        return ProcessedSet(schemaVersion = 1, processed = canonicalBuckets(parsed.processed))
    }

    /** True when [ref] (by type+id) is already in the set. */
    fun hasProcessed(set: ProcessedSet, ref: SourceRef): Boolean =
        set.processed[ref.type]?.contains(ref.id) == true

    /** Returns a new set with [refs] added (idempotent, does not mutate [set]). */
    fun addProcessed(set: ProcessedSet, refs: List<SourceRef>): ProcessedSet {
        val next = LinkedHashMap<String, MutableList<String>>()
        for (type in SourceType.ALL) next[type] = (set.processed[type] ?: emptyList()).toMutableList()
        for (ref in refs) {
            val bucket = next.getOrPut(ref.type) { mutableListOf() }
            if (!bucket.contains(ref.id)) bucket.add(ref.id)
        }
        return ProcessedSet(schemaVersion = 1, processed = next.mapValues { it.value.toList() })
    }

    /** Persists the set via the provider (byte-stable tab-indented JSON). */
    fun saveProcessedSet(set: ProcessedSet, storage: StorageProvider) {
        storage.writeFiles(
            listOf(FileWrite(path = PROCESSED_PATH, content = TopicJson.stringify(set))),
            "Update topic KB processed-source set",
        )
    }

    /** Rebuilds the bucket map in canonical `summary, plan, note, userfile` order. */
    private fun canonicalBuckets(src: Map<String, List<String>>): Map<String, List<String>> {
        val out = LinkedHashMap<String, List<String>>()
        for (type in SourceType.ALL) out[type] = src[type] ?: emptyList()
        return out
    }
}
