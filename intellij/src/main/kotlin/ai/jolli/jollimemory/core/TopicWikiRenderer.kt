package ai.jolli.jollimemory.core

/**
 * TopicWikiRenderer — reads all topic pages and asks the [StorageProvider] to
 * render the visible `_wiki/`. No-op on backends without a visible layer
 * (the default [StorageProvider.renderTopicWiki] is a no-op). Called after
 * ingest (compile sweep).
 *
 * Kotlin port of `cli/src/core/TopicWikiRenderer.ts`.
 */
object TopicWikiRenderer {

    /**
     * Renders the visible wiki from the topic pages named by the authoritative
     * index (NOT a directory scan), so orphaned `topics/<slug>.json` files left
     * by a slug change or `--rebuild` are excluded.
     */
    fun renderTopicKBWiki(storage: StorageProvider) {
        val index = TopicIndexStore.readTopicIndex(storage)
        val pages = mutableListOf<TopicPage>()
        for (entry in index.topics) {
            val page = TopicPageStore.readTopicPage(entry.stableSlug, storage)
            if (page != null) pages.add(page)
        }
        storage.renderTopicWiki(pages)
    }
}
