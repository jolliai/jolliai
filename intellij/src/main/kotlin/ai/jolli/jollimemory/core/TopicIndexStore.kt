package ai.jolli.jollimemory.core

/**
 * TopicIndexStore — read/write `topics/index.json`, the routing index for the
 * topic KB, via a [StorageProvider].
 *
 * Kotlin port of `cli/src/core/TopicIndexStore.ts`.
 */
object TopicIndexStore {

    private val log = JmLogger.create("TopicIndexStore")
    private const val INDEX_PATH = "topics/index.json"

    /** A fresh, empty index. */
    fun emptyTopicIndex(): TopicIndex = TopicIndex(schemaVersion = 1, topics = emptyList())

    /** Reads `topics/index.json`; missing or unparseable → empty index (never throws). */
    fun readTopicIndex(storage: StorageProvider): TopicIndex {
        val raw = storage.readFile(INDEX_PATH) ?: return emptyTopicIndex()
        val parsed = TopicJson.parse(raw, TopicIndex::class.java)
        if (parsed == null) {
            log.warn("Failed to parse %s — treating as empty", INDEX_PATH)
            return emptyTopicIndex()
        }
        // Normalize like the TS reader (parsed.topics ?? []): Gson injects null into the
        // non-null `topics` when the key is absent/null, so coalesce explicitly.
        @Suppress("USELESS_ELVIS")
        val topics = parsed.topics ?: emptyList()
        return TopicIndex(schemaVersion = 1, topics = topics)
    }

    /** Persists the index via the provider. */
    fun saveTopicIndex(index: TopicIndex, storage: StorageProvider) {
        storage.writeFiles(
            listOf(FileWrite(path = INDEX_PATH, content = TopicJson.stringify(index))),
            "Update topic KB index (${index.topics.size} topics)",
        )
    }
}
